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


test("ride quotes reject destinations outside active service areas before routing", async () => {
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
    if (url.includes("/rest/v1/sjelle_cities?")) {
      return new Response(JSON.stringify([{
        id: "00000000-0000-4000-8000-000000000010",
        slug: "prishtina", active: true, rides_enabled: true,
      }]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/rest/v1/sjelle_service_areas?")) {
      return new Response(JSON.stringify([{
        boundary_geojson: {
          type: "Polygon",
          coordinates: [[[21.0, 42.6], [21.2, 42.6], [21.2, 42.7], [21.0, 42.7], [21.0, 42.6]]],
        },
      }]), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error("Destination outside coverage must be rejected before routing or quote creation");
  };
  try {
    const result = await worker.fetch(new Request("https://api.example/api/v1/ride-quotes", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({
        city: "prishtina",
        pickup_label: "Pickup in service area",
        pickup_lat: 42.65,
        pickup_lon: 21.1,
        destination_label: "Destination outside service area",
        destination_lat: 42.8,
        destination_lon: 21.3,
        vehicle_type: "standard",
      }),
    }), {
      APP_ENV: "test",
      ALLOWED_ORIGIN: "https://sjelle.example",
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "public-test-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
      ROUTING_API_URL: "https://routing.example",
    } as never);
    assert.equal(result.status, 400);
    assert.equal((await result.json() as { error?: { code?: string } }).error?.code, "DESTINATION_OUTSIDE_SERVICE_AREA");
    assert.equal(requests.some(url => url.includes("/route/v1/")), false);
    assert.equal(requests.some(url => url.includes("/rest/v1/sjelle_ride_quotes")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("driver location rejects coordinates outside Kosovo before database access", async () => {
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
    throw new Error("Invalid driver coordinates must be rejected before database access");
  };
  try {
    const result = await worker.fetch(new Request("https://api.example/api/v1/driver/location", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ latitude: 0, longitude: 0, accuracy_m: 10 }),
    }), {
      APP_ENV: "test",
      ALLOWED_ORIGIN: "https://sjelle.example",
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "public-test-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
    } as never);
    assert.equal(result.status, 400);
    assert.equal((await result.json() as { error?: { code?: string } }).error?.code, "INVALID_LOCATION");
    assert.equal(requests.filter(url => url.includes("/rest/v1/")).length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("driver cannot complete a cash job without confirming collection", async () => {
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
    throw new Error("Cash confirmation validation must happen before the job RPC");
  };
  try {
    const result = await worker.fetch(new Request("https://api.example/api/v1/driver/jobs/ride/00000000-0000-4000-8000-000000000001/status", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ status: "completed", cash_collected: false }),
    }), {
      APP_ENV: "test",
      ALLOWED_ORIGIN: "https://sjelle.example",
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "public-test-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
    } as never);
    assert.equal(result.status, 400);
    assert.equal((await result.json() as { error?: { code?: string } }).error?.code, "CASH_COLLECTION_CONFIRMATION_REQUIRED");
    assert.equal(requests.some(url => url.includes("/rest/v1/rpc/sjelle_driver_update_job")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("driver completion records successful cash confirmation through the atomic job RPC", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body?: string }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    if (url.endsWith("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "00000000-0000-4000-8000-000000000099" }), { status: 200 });
    }
    if (url.includes("/rest/v1/rpc/sjelle_driver_update_job")) {
      return new Response(JSON.stringify({ status: "completed", cash_collected: true }), { status: 200 });
    }
    throw new Error("Unexpected backend request");
  };
  try {
    const result = await worker.fetch(new Request("https://api.example/api/v1/driver/jobs/ride/00000000-0000-4000-8000-000000000001/status", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ status: "completed", cash_collected: true }),
    }), {
      APP_ENV: "test", ALLOWED_ORIGIN: "https://sjelle.example",
      SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "public-test-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
    } as never);
    assert.equal(result.status, 200);
    assert.equal(calls.filter(call => call.url.includes("/rest/v1/rpc/sjelle_driver_update_job")).length, 1);
    const rpcBody = JSON.parse(calls.find(call => call.url.includes("/rest/v1/rpc/sjelle_driver_update_job"))!.body!);
    assert.equal(rpcBody.p_job_kind, "ride");
    assert.equal(rpcBody.p_next_status, "completed");
    assert.equal(rpcBody.p_cash_collected, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("delivery cannot be marked delivered when cash confirmation is missing", async () => {
  const originalFetch = globalThis.fetch;
  let rpcCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "00000000-0000-4000-8000-000000000099" }), { status: 200 });
    if (url.includes("/rest/v1/rpc/sjelle_driver_update_job")) rpcCalls += 1;
    throw new Error("Missing cash confirmation must not reach the RPC");
  };
  try {
    const result = await worker.fetch(new Request("https://api.example/api/v1/driver/jobs/delivery/00000000-0000-4000-8000-000000000002/status", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ status: "delivered" }),
    }), {
      APP_ENV: "test", ALLOWED_ORIGIN: "https://sjelle.example",
      SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "public-test-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
    } as never);
    assert.equal(result.status, 400);
    assert.equal((await result.json() as { error?: { code?: string } }).error?.code, "CASH_COLLECTION_CONFIRMATION_REQUIRED");
    assert.equal(rpcCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("driver job status rejects a non-boolean cash confirmation before backend mutation", async () => {
  const originalFetch = globalThis.fetch;
  let rpcCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "00000000-0000-4000-8000-000000000099" }), { status: 200 });
    if (url.includes("/rest/v1/rpc/sjelle_driver_update_job")) rpcCalls += 1;
    throw new Error("Invalid cash confirmation must not reach the RPC");
  };
  try {
    const result = await worker.fetch(new Request("https://api.example/api/v1/driver/jobs/ride/00000000-0000-4000-8000-000000000001/status", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ status: "in_progress", cash_collected: "yes" }),
    }), {
      APP_ENV: "test", ALLOWED_ORIGIN: "https://sjelle.example",
      SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "public-test-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
    } as never);
    assert.equal(result.status, 400);
    assert.equal((await result.json() as { error?: { code?: string } }).error?.code, "INVALID_JOB_TRANSITION");
    assert.equal(rpcCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("driver cannot record cash collection before the terminal job state", async () => {
  const originalFetch = globalThis.fetch;
  let rpcCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "00000000-0000-4000-8000-000000000099" }), { status: 200 });
    if (url.includes("/rest/v1/rpc/sjelle_driver_update_job")) rpcCalls += 1;
    throw new Error("Premature cash confirmation must not reach the RPC");
  };
  try {
    const result = await worker.fetch(new Request("https://api.example/api/v1/driver/jobs/ride/00000000-0000-4000-8000-000000000001/status", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ status: "in_progress", cash_collected: true }),
    }), {
      APP_ENV: "test", ALLOWED_ORIGIN: "https://sjelle.example",
      SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "public-test-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
    } as never);
    assert.equal(result.status, 400);
    assert.equal((await result.json() as { error?: { code?: string } }).error?.code, "CASH_CONFIRMATION_ONLY_ON_COMPLETION");
    assert.equal(rpcCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("admin reconciliation rejects invalid date ranges before reading ledger entries", async () => {
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
    if (url.includes("/rest/v1/sjelle_user_roles?")) {
      return new Response(JSON.stringify([{ role: "admin" }]), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    throw new Error("Invalid reconciliation date range must be rejected before ledger access");
  };
  try {
    const result = await worker.fetch(new Request("https://api.example/api/v1/admin/reconciliation?from=2025-01-01&to=2026-01-02", {
      method: "GET",
      headers: { authorization: "Bearer test-token" },
    }), {
      APP_ENV: "test",
      ALLOWED_ORIGIN: "https://sjelle.example",
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "public-test-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
    } as never);
    assert.equal(result.status, 400);
    assert.equal((await result.json() as { error?: { code?: string } }).error?.code, "INVALID_DATE_RANGE");
    assert.equal(requests.some(url => url.includes("/rest/v1/sjelle_ledger_entries")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("admin reconciliation returns signed ledger totals grouped by account type", async () => {
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
    if (url.includes("/rest/v1/sjelle_user_roles?")) {
      return new Response(JSON.stringify([{ role: "admin" }]), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/rest/v1/sjelle_ledger_entries?")) {
      return new Response(JSON.stringify([
        { id: "1", related_ride_id: "ride-1", related_order_id: null, account_type: "customer_cash_due", account_user_id: "customer-1", amount_cents: "-850", currency: "EUR", entry_type: "cash_collection_customer_due_cleared", idempotency_key: "ride:1:customer", metadata: {}, created_at: "2026-10-21T10:00:00Z" },
        { id: "2", related_ride_id: "ride-1", related_order_id: null, account_type: "driver_cash_collected", account_user_id: "driver-1", amount_cents: "850", currency: "EUR", entry_type: "cash_collection_driver_received", idempotency_key: "ride:1:driver", metadata: {}, created_at: "2026-10-21T10:00:00Z" },
      ]), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error("Unexpected reconciliation request: " + url);
  };
  try {
    const result = await worker.fetch(new Request("https://api.example/api/v1/admin/reconciliation?from=2026-10-21&to=2026-10-21", {
      method: "GET",
      headers: { authorization: "Bearer test-token" },
    }), {
      APP_ENV: "test",
      ALLOWED_ORIGIN: "https://sjelle.example",
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "public-test-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
    } as never);
    const payload = await result.json() as { data?: unknown[]; summary?: Array<{ account_type: string; entry_count: number; net_amount_cents: number }>; meta?: { possibly_truncated: boolean } };
    assert.equal(result.status, 200);
    assert.equal(payload.data?.length, 2);
    assert.deepEqual(payload.summary, [
      { account_type: "customer_cash_due", entry_count: 1, net_amount_cents: -850 },
      { account_type: "driver_cash_collected", entry_count: 1, net_amount_cents: 850 },
    ]);
    assert.equal(payload.meta?.possibly_truncated, false);
    assert.equal(requests.some(url => url.includes("sjelle_ledger_entries") && url.includes("limit=1000")), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("admin reconciliation fails closed when account totals overflow safe integer cents", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "00000000-0000-4000-8000-000000000099" }), { status: 200 });
    if (url.includes("/rest/v1/sjelle_user_roles?")) return new Response(JSON.stringify([{ role: "admin" }]), { status: 200 });
    if (url.includes("/rest/v1/sjelle_ledger_entries?")) return new Response(JSON.stringify([
      { id: "1", related_ride_id: "r1", related_order_id: null, account_type: "driver_cash_collected", account_user_id: "d1", amount_cents: "9007199254740991", currency: "EUR", entry_type: "test", idempotency_key: "k1", metadata: {}, created_at: "2026-10-21T10:00:00Z" },
      { id: "2", related_ride_id: "r2", related_order_id: null, account_type: "driver_cash_collected", account_user_id: "d1", amount_cents: "1", currency: "EUR", entry_type: "test", idempotency_key: "k2", metadata: {}, created_at: "2026-10-21T10:00:01Z" }
    ]), { status: 200 });
    throw new Error("Unexpected reconciliation request: " + url);
  };
  try {
    const result = await worker.fetch(new Request("https://api.example/api/v1/admin/reconciliation?from=2026-10-21&to=2026-10-21", { method: "GET", headers: { authorization: "Bearer test-token" } }), {
      APP_ENV: "test", ALLOWED_ORIGIN: "https://sjelle.example", SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "public-test-key", SUPABASE_SERVICE_ROLE_KEY: "service-test-key"
    } as never);
    assert.equal(result.status, 503);
    assert.equal((await result.json() as { error?: { code?: string } }).error?.code, "RECONCILIATION_TOTAL_OVERFLOW");
  } finally { globalThis.fetch = originalFetch; }
});


test("admin reconciliation rejects non-EUR ledger rows instead of mixing currencies", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "00000000-0000-4000-8000-000000000099" }), { status: 200 });
    if (url.includes("/rest/v1/sjelle_user_roles?")) return new Response(JSON.stringify([{ role: "admin" }]), { status: 200 });
    if (url.includes("/rest/v1/sjelle_ledger_entries?")) return new Response(JSON.stringify([{ id: "1", related_ride_id: null, related_order_id: "o1", account_type: "driver_cash_collected", account_user_id: "d1", amount_cents: "100", currency: "USD", entry_type: "test", idempotency_key: "k1", metadata: {}, created_at: "2026-10-21T10:00:00Z" }]), { status: 200 });
    throw new Error("Unexpected reconciliation request: " + url);
  };
  try {
    const result = await worker.fetch(new Request("https://api.example/api/v1/admin/reconciliation?from=2026-10-21&to=2026-10-21", { method: "GET", headers: { authorization: "Bearer test-token" } }), {
      APP_ENV: "test", ALLOWED_ORIGIN: "https://sjelle.example", SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "public-test-key", SUPABASE_SERVICE_ROLE_KEY: "service-test-key"
    } as never);
    assert.equal(result.status, 503);
    assert.equal((await result.json() as { error?: { code?: string } }).error?.code, "RECONCILIATION_DATA_INVALID");
  } finally { globalThis.fetch = originalFetch; }
});


test("support ticket endpoints reject unauthenticated access before database work", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; return new Response("{}", { status: 500 }); };
  try {
    const list = await worker.fetch(new Request("https://api.example/api/v1/support-tickets"), {
      APP_ENV: "test", ALLOWED_ORIGIN: "https://sjelle.example",
      SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "public-test-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
    } as never);
    assert.equal(list.status, 401);
    assert.equal((await list.json() as { error?: { code?: string } }).error?.code, "UNAUTHENTICATED");
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("support ticket creation validates category and description before database writes", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "00000000-0000-4000-8000-000000000001" }), { status: 200 });
    }
    return new Response("unexpected database call", { status: 500 });
  };
  try {
    const result = await worker.fetch(new Request("https://api.example/api/v1/support-tickets", {
      method: "POST",
      headers: { authorization: "Bearer user-token", "content-type": "application/json" },
      body: JSON.stringify({ category: "made-up", description: "short" }),
    }), {
      APP_ENV: "test", ALLOWED_ORIGIN: "https://sjelle.example",
      SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "public-test-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
    } as never);
    assert.equal(result.status, 400);
    assert.equal((await result.json() as { error?: { code?: string } }).error?.code, "INVALID_SUPPORT_TICKET");
    assert.deepEqual(requests, ["https://project.supabase.co/auth/v1/user"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("support ticket creation rejects a linked ride that does not belong to the requester", async () => {
  const originalFetch = globalThis.fetch;
  const userId = "00000000-0000-4000-8000-000000000001";
  const rideId = "00000000-0000-4000-8000-000000000002";
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: userId }), { status: 200 });
    if (url.includes("/rest/v1/sjelle_rides?")) return new Response("[]", { status: 200 });
    return new Response("unexpected database call", { status: 500 });
  };
  try {
    const result = await worker.fetch(new Request("https://api.example/api/v1/support-tickets", {
      method: "POST",
      headers: { authorization: "Bearer user-token", "content-type": "application/json" },
      body: JSON.stringify({ category: "ride", description: "The driver never arrived and I need help.", ride_id: rideId }),
    }), {
      APP_ENV: "test", ALLOWED_ORIGIN: "https://sjelle.example",
      SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "public-test-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
    } as never);
    assert.equal(result.status, 404);
    assert.equal((await result.json() as { error?: { code?: string } }).error?.code, "LINKED_RIDE_NOT_FOUND");
    assert.equal(requests.length, 2);
    assert.ok(requests[1].includes("customer_id=eq." + userId));
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("admin support queue rejects unauthenticated access before database work", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response("{}", { status: 500 }); };
  try {
    const result = await worker.fetch(new Request("https://api.example/api/v1/admin/support-tickets"), {
      APP_ENV: "test", ALLOWED_ORIGIN: "https://sjelle.example",
      SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "public-test-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
    } as never);
    assert.equal(result.status, 401);
    assert.equal((await result.json() as { error?: { code?: string } }).error?.code, "UNAUTHENTICATED");
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin support status update validates status before database writes", async () => {
  const originalFetch = globalThis.fetch;
  const userId = "00000000-0000-4000-8000-000000000001";
  const ticketId = "00000000-0000-4000-8000-000000000002";
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: userId }), { status: 200 });
    if (url.includes("/rest/v1/sjelle_user_roles?")) return new Response(JSON.stringify([{ role: "admin" }]), { status: 200 });
    return new Response("unexpected database call", { status: 500 });
  };
  try {
    const result = await worker.fetch(new Request("https://api.example/api/v1/admin/support-tickets/" + ticketId, {
      method: "PATCH",
      headers: { authorization: "Bearer user-token", "content-type": "application/json" },
      body: JSON.stringify({ status: "delete_everything" }),
    }), {
      APP_ENV: "test", ALLOWED_ORIGIN: "https://sjelle.example",
      SUPABASE_URL: "https://project.supabase.co", SUPABASE_PUBLISHABLE_KEY: "public-test-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
    } as never);
    assert.equal(result.status, 400);
    assert.equal((await result.json() as { error?: { code?: string } }).error?.code, "INVALID_SUPPORT_STATUS");
    assert.equal(calls.length, 2);
    assert.ok(calls[1].includes("/rest/v1/sjelle_user_roles?"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("ride quotes accept valid MultiPolygon service areas including non-first polygons", async () => {
  const originalFetch = globalThis.fetch;
  const cityId = "00000000-0000-4000-8000-000000000010";
  const quoteId = "00000000-0000-4000-8000-000000000020";
  const area = {
    type: "MultiPolygon",
    coordinates: [
      [[[21.0, 42.6], [21.1, 42.6], [21.1, 42.7], [21.0, 42.7], [21.0, 42.6]]],
      [[[21.3, 42.7], [21.4, 42.7], [21.4, 42.8], [21.3, 42.8], [21.3, 42.7]]],
    ],
  };
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "00000000-0000-4000-8000-000000000099" }), { status: 200 });
    if (url.includes("/rest/v1/sjelle_cities?")) return new Response(JSON.stringify([{ id: cityId, slug: "prishtina", active: true, rides_enabled: true }]), { status: 200 });
    if (url.includes("/rest/v1/sjelle_service_areas?")) return new Response(JSON.stringify([{ boundary_geojson: area }]), { status: 200 });
    if (url.includes("/rest/v1/sjelle_fixed_route_prices?")) return new Response("[]", { status: 200 });
    if (url.startsWith("https://routing.example/route/v1/driving/")) return new Response(JSON.stringify({ code: "Ok", routes: [{ distance: 1200, duration: 240 }] }), { status: 200 });
    if (url.includes("/rest/v1/sjelle_city_pricing?")) return new Response(JSON.stringify([{ version: "test-v1", ride_base_fare_cents: 100, ride_minimum_fare_cents: 150, ride_per_km_cents: 50, ride_per_minute_cents: 10 }]), { status: 200 });
    if (url.includes("/rest/v1/sjelle_ride_quotes") && init?.method === "POST") return new Response(JSON.stringify([{ id: quoteId, expires_at: "2026-10-21T22:15:00.000Z" }]), { status: 201 });
    throw new Error("Unexpected request in MultiPolygon service-area test: " + url);
  };
  try {
    const result = await worker.fetch(new Request("https://api.example/api/v1/ride-quotes", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({
        city: "prishtina",
        pickup_label: "Pickup in second polygon",
        pickup_lat: 42.71,
        pickup_lon: 21.31,
        destination_label: "Destination in second polygon",
        destination_lat: 42.72,
        destination_lon: 21.32,
        vehicle_type: "standard",
      }),
    }), {
      APP_ENV: "test",
      ALLOWED_ORIGIN: "https://sjelle.example",
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "public-test-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
      ROUTING_API_URL: "https://routing.example",
    } as never);
    assert.equal(result.status, 201);
    const body = await result.json() as { data?: { quote_id?: string; amount_cents?: number } };
    assert.equal(body.data?.quote_id, quoteId);
    assert.equal(body.data?.amount_cents, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("city activation refuses draft-only service areas before enabling any public service", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string }> = [];
  const userId = "00000000-0000-4000-8000-000000000099";
  const cityId = "00000000-0000-4000-8000-000000000010";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: userId }), { status: 200 });
    if (url.includes("/rest/v1/sjelle_user_roles?")) return new Response(JSON.stringify([{ role: "admin" }]), { status: 200 });
    if (url.includes("/rest/v1/sjelle_cities?slug=eq.prishtina")) return new Response(JSON.stringify([{ id: cityId }]), { status: 200 });
    if (url.includes("/rest/v1/sjelle_service_areas?")) return new Response("[]", { status: 200 });
    throw new Error("City activation must fail before pricing, supply checks or city mutation: " + url);
  };
  try {
    const result = await worker.fetch(new Request("https://api.example/api/v1/admin/cities/prishtina/services", {
      method: "PATCH",
      headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
      body: JSON.stringify({
        active: true,
        rides_enabled: false,
        food_enabled: true,
        confirm_ready: true,
        reason: "Attempted launch before service-area review",
      }),
    }), {
      APP_ENV: "test",
      ALLOWED_ORIGIN: "https://sjelle.example",
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "public-test-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
    } as never);
    assert.equal(result.status, 409);
    assert.equal((await result.json() as { error?: { code?: string } }).error?.code, "NO_ACTIVE_SERVICE_AREA");
    assert.equal(calls.some(call => call.method === "PATCH" && call.url.includes("/rest/v1/sjelle_cities?")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
