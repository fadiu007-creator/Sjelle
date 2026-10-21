import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";

const env = {
  APP_ENV: "test",
  ALLOWED_ORIGIN: "https://sjelle.example",
} as never;

test("health endpoint is available without database secrets", async () => {
  const result = await worker.fetch(new Request("https://api.example/api/v1/health"), env);
  assert.equal(result.status, 200);
  const body = await result.json() as { ok?: boolean; service?: string };
  assert.equal(body.ok, true);
  assert.equal(body.service, "sjelle-api");
});

test("readiness fails closed when Supabase is not configured", async () => {
  const result = await worker.fetch(new Request("https://api.example/api/v1/ready"), env);
  assert.equal(result.status, 503);
  const body = await result.json() as { ok?: boolean; error?: { code?: string } };
  assert.equal(body.ok, false);
  assert.equal(body.error?.code, "BACKEND_NOT_CONFIGURED");
});

test("readiness succeeds only when core config and database connectivity are present", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
  try {
    const result = await worker.fetch(new Request("https://api.example/api/v1/ready"), {
      APP_ENV: "test",
      ALLOWED_ORIGIN: "https://sjelle.example",
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "public-test-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
      ROUTING_API_URL: "https://routing.example",
      GEOCODING_API_URL: "https://geocoding.example",
    } as never);
    assert.equal(result.status, 200);
    const body = await result.json() as { ok?: boolean; database?: string; providers?: { routing?: string; geocoding?: string } };
    assert.equal(body.ok, true);
    assert.equal(body.database, "reachable");
    assert.equal(body.providers?.routing, "configured");
    assert.equal(body.providers?.geocoding, "configured");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("readiness fails closed when routing or geocoding providers are missing", async () => {
  const result = await worker.fetch(new Request("https://api.example/api/v1/ready"), {
    APP_ENV: "test",
    ALLOWED_ORIGIN: "https://sjelle.example",
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "public-test-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
  } as never);
  assert.equal(result.status, 503);
  const body = await result.json() as { ok?: boolean; error?: { code?: string; missing?: string[] } };
  assert.equal(body.ok, false);
  assert.equal(body.error?.code, "ENVIRONMENT_NOT_CONFIGURED");
  assert.deepEqual(body.error?.missing, ["ROUTING_API_URL", "GEOCODING_API_URL"]);
});

test("CORS preflight is empty and only reflects the configured origin", async () => {
  const allowed = await worker.fetch(new Request("https://api.example/api/v1/rides", {
    method: "OPTIONS",
    headers: { origin: "https://sjelle.example", "access-control-request-method": "POST" },
  }), env);
  assert.equal(allowed.status, 204);
  assert.equal(await allowed.text(), "");
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://sjelle.example");

  const denied = await worker.fetch(new Request("https://api.example/api/v1/rides", {
    method: "OPTIONS",
    headers: { origin: "https://attacker.example", "access-control-request-method": "POST" },
  }), env);
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
});

test("small API request bodies remain readable after size enforcement", async () => {
  const result = await worker.fetch(new Request("https://api.example/api/v1/not-a-route", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok: true }),
  }), env);
  assert.equal(result.status, 404);
});

test("oversized API bodies are rejected before parsing or backend access", async () => {
  const body = "x".repeat(2 * 1024 * 1024 + 1);
  const request = new Request("https://api.example/api/v1/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(body.length) },
    body,
  });
  const result = await worker.fetch(request, env);
  assert.equal(result.status, 413);
  const payload = await result.json() as { error?: { code?: string } };
  assert.equal(payload.error?.code, "REQUEST_TOO_LARGE");

  const withoutLength = await worker.fetch(new Request("https://api.example/api/v1/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new Uint8Array(2 * 1024 * 1024 + 1),
  }), env);
  assert.equal(withoutLength.status, 413);
});


test("ride and food-order creation reject unauthenticated requests before backend work", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ message: "should not be called" }), { status: 500 });
  };
  try {
    const ride = await worker.fetch(new Request("https://api.example/api/v1/rides", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "ride-request-key-123" },
      body: JSON.stringify({ quote_id: "00000000-0000-4000-8000-000000000001" }),
    }), {
      APP_ENV: "test", ALLOWED_ORIGIN: "https://sjelle.example",
      SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "public-test-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
    } as never);
    const food = await worker.fetch(new Request("https://api.example/api/v1/food-orders", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "food-request-key-123" },
      body: JSON.stringify({}),
    }), {
      APP_ENV: "test", ALLOWED_ORIGIN: "https://sjelle.example",
      SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "public-test-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
    } as never);

    assert.equal(ride.status, 401);
    assert.equal((await ride.json() as { error?: { code?: string } }).error?.code, "UNAUTHENTICATED");
    assert.equal(food.status, 401);
    assert.equal((await food.json() as { error?: { code?: string } }).error?.code, "UNAUTHENTICATED");
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("food-order creation validates idempotency and order shape before database writes", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "00000000-0000-4000-8000-000000000099", email: "customer@example.test" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    throw new Error("Unexpected database call during validation");
  };
  const configuredEnv = {
    APP_ENV: "test", ALLOWED_ORIGIN: "https://sjelle.example",
    SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "public-test-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
  } as never;
  try {
    const missingKey = await worker.fetch(new Request("https://api.example/api/v1/food-orders", {
      method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({}),
    }), configuredEnv);
    assert.equal(missingKey.status, 400);
    assert.equal((await missingKey.json() as { error?: { code?: string } }).error?.code, "IDEMPOTENCY_KEY_REQUIRED");

    const malformedOrder = await worker.fetch(new Request("https://api.example/api/v1/food-orders", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json", "idempotency-key": "food-request-key-123" },
      body: JSON.stringify({ restaurant_id: "not-a-uuid", delivery_address_text: "Main street", delivery_lat: 42.6, delivery_lon: 21.1, items: [] }),
    }), configuredEnv);
    assert.equal(malformedOrder.status, 400);
    assert.equal((await malformedOrder.json() as { error?: { code?: string } }).error?.code, "INVALID_ORDER");
    assert.equal(requests.filter(url => url.includes("/rest/v1/")).length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ride booking requires a quote or route and a sufficiently long idempotency key", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "00000000-0000-4000-8000-000000000099" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    throw new Error("Ride request validation must not reach the database");
  };
  try {
    const result = await worker.fetch(new Request("https://api.example/api/v1/rides", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json", "idempotency-key": "short" },
      body: JSON.stringify({}),
    }), {
      APP_ENV: "test", ALLOWED_ORIGIN: "https://sjelle.example",
      SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "public-test-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
    } as never);
    assert.equal(result.status, 400);
    assert.equal((await result.json() as { error?: { code?: string } }).error?.code, "INVALID_RIDE_REQUEST");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("readiness reports database failures as unavailable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: "database unavailable" }), {
    status: 503, headers: { "content-type": "application/json" },
  });
  try {
    const result = await worker.fetch(new Request("https://api.example/api/v1/ready"), {
      APP_ENV: "test",
      ALLOWED_ORIGIN: "https://sjelle.example",
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "public-test-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
      ROUTING_API_URL: "https://routing.example",
      GEOCODING_API_URL: "https://geocoding.example",
    } as never);
    assert.equal(result.status, 503);
    const body = await result.json() as { ok?: boolean; error?: { code?: string } };
    assert.equal(body.ok, false);
    assert.equal(body.error?.code, "DATABASE_UNAVAILABLE");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("food orders reject coordinates outside the launch region before database access", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "00000000-0000-4000-8000-000000000099" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    throw new Error("Invalid coordinates must be rejected before database access");
  };
  try {
    const result = await worker.fetch(new Request("https://api.example/api/v1/food-orders", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "content-type": "application/json",
        "idempotency-key": "food-request-key-123",
      },
      body: JSON.stringify({
        restaurant_id: "00000000-0000-4000-8000-000000000001",
        delivery_address_text: "Main street, Prishtina",
        delivery_lat: 51.5072,
        delivery_lon: -0.1276,
        items: [{ id: "00000000-0000-4000-8000-000000000002", quantity: 1 }],
      }),
    }), {
      APP_ENV: "test",
      ALLOWED_ORIGIN: "https://sjelle.example",
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "public-test-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
    } as never);
    assert.equal(result.status, 400);
    assert.equal((await result.json() as { error?: { code?: string } }).error?.code, "INVALID_DELIVERY_ADDRESS");
    assert.equal(requests.filter(url => url.includes("/rest/v1/")).length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
