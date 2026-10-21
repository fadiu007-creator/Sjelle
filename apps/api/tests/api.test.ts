import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";

const callWorker = (request: Request, env: Parameters<typeof worker.fetch>[1]) =>
  worker.fetch(request, env);

test("health is available without database configuration", async () => {
  const response = await callWorker(new Request("https://sjelle.test/api/v1/health"), {});
  const body = await response.json() as { ok: boolean; service: string; request_id: string };
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.service, "sjelle-api");
  assert.ok(body.request_id);
});

test("readiness fails clearly when backend secrets are missing", async () => {
  const response = await callWorker(new Request("https://sjelle.test/api/v1/ready"), {});
  const body = await response.json() as { ok: boolean; error: { code: string } };
  assert.equal(response.status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "BACKEND_NOT_CONFIGURED");
});

test("unauthenticated profile requests are rejected before database access", async () => {
  const response = await callWorker(
    new Request("https://sjelle.test/api/v1/me", { method: "GET" }),
    { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "test-only" },
  );
  const body = await response.json() as { error: { code: string } };
  assert.equal(response.status, 401);
  assert.equal(body.error.code, "UNAUTHENTICATED");
});

test("unknown endpoints never pretend to succeed", async () => {
  const response = await callWorker(new Request("https://sjelle.test/api/v1/not-a-real-endpoint"), {});
  const body = await response.json() as { error: { code: string } };
  assert.equal(response.status, 404);
  assert.equal(body.error.code, "NOT_FOUND");
});

test("restaurant list requires an explicit city slug", async () => {
  const response = await callWorker(
    new Request("https://sjelle.test/api/v1/restaurants"),
    {},
  );
  const body = await response.json() as { error: { code: string } };
  assert.equal(response.status, 400);
  assert.equal(body.error.code, "CITY_REQUIRED");
});

test("menu route rejects malformed restaurant slugs", async () => {
  const response = await callWorker(
    new Request("https://sjelle.test/api/v1/restaurants/!!/menu"),
    {},
  );
  const body = await response.json() as { error: { code: string } };
  assert.equal(response.status, 400);
  assert.equal(body.error.code, "INVALID_RESTAURANT_SLUG");
});

test("city discovery returns only the explicit public city fields", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    assert.match(String(input), /sjelle_cities\?select=slug,name,country_code,timezone,rides_enabled,food_enabled,active/);
    return new Response(JSON.stringify([
      { slug: "prishtina", name: "Prishtina", country_code: "XK", timezone: "Europe/Belgrade", rides_enabled: false, food_enabled: false, active: false },
    ]), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const response = await callWorker(
      new Request("https://sjelle.test/api/v1/cities"),
      { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "test-only" },
    );
    const body = await response.json() as { data: Array<{ slug: string; active: boolean }> };
    assert.equal(response.status, 200);
    assert.equal(body.data[0]?.slug, "prishtina");
    assert.equal(body.data[0]?.active, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("inactive food cities do not trigger restaurant queries", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls += 1;
    assert.match(String(input), /sjelle_cities\?slug=eq\.prishtina/);
    return new Response(JSON.stringify([
      { id: "city-id", slug: "prishtina", active: false, food_enabled: false },
    ]), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const response = await callWorker(
      new Request("https://sjelle.test/api/v1/restaurants?city=prishtina"),
      { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "test-only" },
    );
    const body = await response.json() as { data: unknown[]; meta: { service_available: boolean } };
    assert.equal(response.status, 200);
    assert.deepEqual(body.data, []);
    assert.equal(body.meta.service_available, false);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("malformed bearer tokens are rejected without calling Supabase", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("fetch must not be called for malformed tokens");
  }) as typeof fetch;
  try {
    const response = await callWorker(new Request("https://sjelle.test/api/v1/me", {
      headers: { authorization: "Bearernot-a-token" },
    }), {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "test-publishable",
      SUPABASE_SERVICE_ROLE_KEY: "test-only",
    });
    const body = await response.json() as { error: { code: string } };
    assert.equal(response.status, 401);
    assert.equal(body.error.code, "UNAUTHENTICATED");
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("food order creation requires authentication before processing", async () => {
  const response = await callWorker(new Request("https://sjelle.test/api/v1/food-orders", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "0123456789ab" },
    body: JSON.stringify({}),
  }), {});
  const body = await response.json() as { error: { code: string } };
  assert.equal(response.status, 401);
  assert.equal(body.error.code, "UNAUTHENTICATED");
});

test("ride routes require a city slug", async () => {
  const response = await callWorker(new Request("https://sjelle.test/api/v1/ride-routes"), {});
  const body = await response.json() as { error: { code: string } };
  assert.equal(response.status, 400);
  assert.equal(body.error.code, "CITY_REQUIRED");
});


test("ride quote endpoint requires authentication before routing-provider access", async () => {
  const response = await callWorker(new Request("https://sjelle.test/api/v1/ride-quotes", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
  }), {});
  const body = await response.json() as { error: { code: string } };
  assert.equal(response.status, 401);
  assert.equal(body.error.code, "UNAUTHENTICATED");
});

test("driver document uploads require authentication before reading multipart files", async () => {
  const response = await callWorker(new Request("https://sjelle.test/api/v1/driver/documents", { method: "POST" }), {});
  const body = await response.json() as { error: { code: string } };
  assert.equal(response.status, 401);
  assert.equal(body.error.code, "UNAUTHENTICATED");
});

test("restaurant applications require authentication", async () => {
  const response = await callWorker(new Request("https://sjelle.test/api/v1/merchant/restaurants", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
  }), {});
  const body = await response.json() as { error: { code: string } };
  assert.equal(response.status, 401);
  assert.equal(body.error.code, "UNAUTHENTICATED");
});

test("admin route configuration requires an authenticated admin", async () => {
  const response = await callWorker(new Request("https://sjelle.test/api/v1/admin/routes", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
  }), {});
  const body = await response.json() as { error: { code: string } };
  assert.equal(response.status, 401);
  assert.equal(body.error.code, "UNAUTHENTICATED");
});


test("driver cannot go offline while an assigned ride is active", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }), { status: 200 });
    if (url.includes("sjelle_driver_profiles?")) {
      return new Response(JSON.stringify([{ user_id: "11111111-1111-4111-8111-111111111111", review_status: "approved", city_id: "22222222-2222-4222-8222-222222222222", selected_mode: "ride" }]), { status: 200 });
    }
    if (url.includes("sjelle_rides?")) return new Response(JSON.stringify([{ id: "33333333-3333-4333-8333-333333333333" }]), { status: 200 });
    if (url.includes("sjelle_delivery_jobs?")) return new Response("[]", { status: 200 });
    if (init?.method === "PATCH") throw new Error("availability must not be updated while a job is active");
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  try {
    const response = await callWorker(new Request("https://sjelle.test/api/v1/driver/availability", {
      method: "PATCH",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ online: false }),
    }), {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "test-publishable",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    });
    const body = await response.json() as { error: { code: string } };
    assert.equal(response.status, 409);
    assert.equal(body.error.code, "DRIVER_HAS_ACTIVE_JOB");
    assert.ok(calls.some(url => url.includes("sjelle_rides?")));
    assert.ok(calls.some(url => url.includes("sjelle_delivery_jobs?")));
    assert.equal(calls.some(url => url.includes("sjelle_driver_profiles?") && url.includes("PATCH")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("driver availability reports a backend error if active-job checks fail", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }), { status: 200 });
    if (url.includes("sjelle_driver_profiles?")) {
      return new Response(JSON.stringify([{ user_id: "11111111-1111-4111-8111-111111111111", review_status: "approved", city_id: "22222222-2222-4222-8222-222222222222", selected_mode: "ride" }]), { status: 200 });
    }
    if (url.includes("sjelle_rides?")) return new Response("database unavailable", { status: 503 });
    if (url.includes("sjelle_delivery_jobs?")) return new Response("[]", { status: 200 });
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  try {
    const response = await callWorker(new Request("https://sjelle.test/api/v1/driver/availability", {
      method: "PATCH",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ online: false }),
    }), {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "test-publishable",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    });
    const body = await response.json() as { error: { code: string } };
    assert.equal(response.status, 503);
    assert.equal(body.error.code, "ACTIVE_JOB_CHECK_FAILED");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
