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

test("authenticated non-admin users cannot read private driver or restaurant application queues", async () => {
  const originalFetch = globalThis.fetch;
  const privateReads: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/rest/v1/sjelle_user_roles?")) {
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/rest/v1/sjelle_driver_documents?") || url.includes("/rest/v1/sjelle_vehicles?") || url.includes("/rest/v1/sjelle_driver_profiles?") || url.includes("/rest/v1/sjelle_restaurants?")) {
      privateReads.push(url);
    }
    throw new Error("Unexpected database request: " + url);
  }) as typeof fetch;
  try {
    for (const path of ["/admin/driver-documents", "/admin/restaurants"]) {
      const response = await callWorker(new Request("https://sjelle.test/api/v1" + path, {
        method: "GET", headers: { authorization: "Bearer test-token" },
      }), {
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_PUBLISHABLE_KEY: "test-publishable",
        SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
      });
      const body = await response.json() as { error: { code: string } };
      assert.equal(response.status, 403, path);
      assert.equal(body.error.code, "FORBIDDEN", path);
    }
    assert.deepEqual(privateReads, [], "private application rows must not be queried for a non-admin");
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("driver cannot go offline while an assigned ride is active", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
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
    assert.ok(calls.some(call => call.url.includes("sjelle_rides?")));
    assert.ok(calls.some(call => call.url.includes("sjelle_delivery_jobs?")));
    assert.equal(calls.some(call => call.url.includes("sjelle_driver_profiles?") && call.method === "PATCH"), false);
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


test("ride completion requires explicit cash collection confirmation", async () => {
  const originalFetch = globalThis.fetch;
  let rpcCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }), { status: 200 });
    if (url.includes("/rest/v1/sjelle_rides?")) return new Response(JSON.stringify([{ payment_method: "cash" }]), { status: 200 });
    if (url.includes("/rpc/")) rpcCalls += 1;
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  try {
    const response = await callWorker(new Request("https://sjelle.test/api/v1/driver/jobs/ride/33333333-3333-4333-8333-333333333333/status", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    }), {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "test-publishable",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    });
    const body = await response.json() as { error: { code: string } };
    assert.equal(response.status, 400);
    assert.equal(body.error.code, "CASH_COLLECTION_CONFIRMATION_REQUIRED");
    assert.equal(rpcCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cash collection cannot be confirmed before a ride reaches completion", async () => {
  const originalFetch = globalThis.fetch;
  let rpcCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }), { status: 200 });
    }
    if (url.includes("/rpc/")) rpcCalls += 1;
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  try {
    const response = await callWorker(new Request("https://sjelle.test/api/v1/driver/jobs/ride/33333333-3333-4333-8333-333333333333/status", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ status: "driver_arriving", cash_collected: true }),
    }), {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "test-publishable",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    });
    const body = await response.json() as { error: { code: string } };
    assert.equal(response.status, 400);
    assert.equal(body.error.code, "CASH_CONFIRMATION_ONLY_ON_COMPLETION");
    assert.equal(rpcCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("delivery completion requires explicit cash collection confirmation", async () => {
  const originalFetch = globalThis.fetch;
  let rpcCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }), { status: 200 });
    if (url.includes("/rest/v1/sjelle_delivery_jobs?")) return new Response(JSON.stringify([{ order_id: "44444444-4444-4444-8444-444444444444" }]), { status: 200 });
    if (url.includes("/rest/v1/sjelle_food_orders?")) return new Response(JSON.stringify([{ payment_method: "cash" }]), { status: 200 });
    if (url.includes("/rpc/")) rpcCalls += 1;
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  try {
    const response = await callWorker(new Request("https://sjelle.test/api/v1/driver/jobs/delivery/33333333-3333-4333-8333-333333333333/status", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ status: "delivered" }),
    }), {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "test-publishable",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    });
    const body = await response.json() as { error: { code: string } };
    assert.equal(response.status, 400);
    assert.equal(body.error.code, "CASH_COLLECTION_CONFIRMATION_REQUIRED");
    assert.equal(rpcCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("delivery cash cannot be confirmed before delivery is complete", async () => {
  const originalFetch = globalThis.fetch;
  let rpcCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }), { status: 200 });
    }
    if (url.includes("/rpc/")) rpcCalls += 1;
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  try {
    const response = await callWorker(new Request("https://sjelle.test/api/v1/driver/jobs/delivery/33333333-3333-4333-8333-333333333333/status", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ status: "picked_up", cash_collected: true }),
    }), {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "test-publishable",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    });
    const body = await response.json() as { error: { code: string } };
    assert.equal(response.status, 400);
    assert.equal(body.error.code, "CASH_CONFIRMATION_ONLY_ON_COMPLETION");
    assert.equal(rpcCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("driver availability uses the atomic database RPC after preflight checks", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
    if (url.endsWith("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }), { status: 200 });
    }
    if (url.includes("sjelle_driver_profiles?")) {
      return new Response(JSON.stringify([{
        user_id: "11111111-1111-4111-8111-111111111111",
        review_status: "approved",
        city_id: "22222222-2222-4222-8222-222222222222",
        selected_mode: "ride",
      }]), { status: 200 });
    }
    if (url.includes("sjelle_rides?") || url.includes("sjelle_delivery_jobs?")) {
      return new Response("[]", { status: 200 });
    }
    if (url.includes("/rpc/sjelle_set_driver_availability")) {
      return new Response(JSON.stringify({ online: false, mode: "ride" }), { status: 200 });
    }
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
    const body = await response.json() as { data: { online: boolean; mode: string } };
    assert.equal(response.status, 200);
    assert.equal(body.data.online, false);
    assert.equal(body.data.mode, "ride");
    assert.ok(calls.some(call => call.url.includes("/rpc/sjelle_set_driver_availability") && call.method === "POST"));
    assert.equal(calls.some(call => call.url.includes("sjelle_driver_profiles?") && call.method === "PATCH"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("atomic driver availability RPC remains authoritative if a job is assigned during preflight", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }), { status: 200 });
    }
    if (url.includes("sjelle_driver_profiles?")) {
      return new Response(JSON.stringify([{
        user_id: "11111111-1111-4111-8111-111111111111",
        review_status: "approved",
        city_id: "22222222-2222-4222-8222-222222222222",
        selected_mode: "ride",
      }]), { status: 200 });
    }
    if (url.includes("sjelle_rides?") || url.includes("sjelle_delivery_jobs?")) {
      return new Response("[]", { status: 200 });
    }
    if (url.includes("/rpc/sjelle_set_driver_availability")) {
      return new Response(JSON.stringify({ message: "DRIVER_HAS_ACTIVE_JOB" }), { status: 409 });
    }
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
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("driver job status rejects non-boolean cash collection flags before database RPC", async () => {
  const originalFetch = globalThis.fetch;
  let rpcCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }), { status: 200 });
    }
    if (url.includes("/rpc/")) rpcCalls += 1;
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  try {
    const response = await callWorker(new Request("https://sjelle.test/api/v1/driver/jobs/ride/33333333-3333-4333-8333-333333333333/status", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ status: "completed", cash_collected: "true" }),
    }), {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "test-publishable",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    });
    const body = await response.json() as { error: { code: string } };
    assert.equal(response.status, 400);
    assert.equal(body.error.code, "INVALID_JOB_TRANSITION");
    assert.equal(rpcCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("driver job status rejects explicit false cash confirmation for terminal transitions before database RPC", async () => {
  const originalFetch = globalThis.fetch;
  let rpcCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }), { status: 200 });
    if (url.includes("/rest/v1/sjelle_delivery_jobs?")) return new Response(JSON.stringify([{ order_id: "44444444-4444-4444-8444-444444444444" }]), { status: 200 });
    if (url.includes("/rest/v1/sjelle_food_orders?")) return new Response(JSON.stringify([{ payment_method: "cash" }]), { status: 200 });
    if (url.includes("/rpc/")) rpcCalls += 1;
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  try {
    const response = await callWorker(new Request("https://sjelle.test/api/v1/driver/jobs/delivery/33333333-3333-4333-8333-333333333333/status", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ status: "delivered", cash_collected: false }),
    }), {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "test-publishable",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    });
    const body = await response.json() as { error: { code: string } };
    assert.equal(response.status, 400);
    assert.equal(body.error.code, "CASH_COLLECTION_CONFIRMATION_REQUIRED");
    assert.equal(rpcCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("successful ride completion sends cash confirmation to the atomic database RPC", async () => {
  const originalFetch = globalThis.fetch;
  let rpcBody: Record<string, unknown> | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }), { status: 200 });
    if (url.includes("/rest/v1/sjelle_rides?")) return new Response(JSON.stringify([{ payment_method: "cash" }]), { status: 200 });
    if (url.includes("/rpc/sjelle_driver_update_job")) {
      assert.equal(init?.method, "POST");
      rpcBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: "33333333-3333-4333-8333-333333333333", status: "completed" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    throw new Error("Unexpected database request: " + url);
  }) as typeof fetch;
  try {
    const response = await callWorker(new Request("https://sjelle.test/api/v1/driver/jobs/ride/33333333-3333-4333-8333-333333333333/status", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ status: "completed", cash_collected: true }),
    }), {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "test-publishable",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(rpcBody, {
      p_driver_id: "11111111-1111-4111-8111-111111111111",
      p_job_kind: "ride",
      p_job_id: "33333333-3333-4333-8333-333333333333",
      p_next_status: "completed",
      p_cash_collected: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("driver job RPC conflicts are returned as conflicts instead of backend outages", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }), { status: 200 });
    }
    if (url.includes("/rpc/sjelle_driver_update_job")) {
      return new Response(JSON.stringify({ message: "INVALID_JOB_TRANSITION" }), {
        status: 409, headers: { "content-type": "application/json" },
      });
    }
    throw new Error("Unexpected database request: " + url);
  }) as typeof fetch;
  try {
    const response = await callWorker(new Request("https://sjelle.test/api/v1/driver/jobs/ride/33333333-3333-4333-8333-333333333333/status", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ status: "driver_arriving" }),
    }), {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "test-publishable",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    });
    const body = await response.json() as { error: { code: string } };
    assert.equal(response.status, 409);
    assert.equal(body.error.code, "INVALID_JOB_TRANSITION");
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("duplicate driver applications are rejected by the atomic database function", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.endsWith("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }), { status: 200 });
    }
    if (url.includes("/sjelle_cities?slug=eq.prishtina")) {
      return new Response(JSON.stringify([{ id: "22222222-2222-4222-8222-222222222222", slug: "prishtina" }]), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/rpc/sjelle_apply_for_driver")) {
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        p_user_id: "11111111-1111-4111-8111-111111111111",
        p_city_id: "22222222-2222-4222-8222-222222222222",
        p_selected_mode: "ride",
      });
      return new Response(JSON.stringify({ message: "duplicate key value violates unique constraint" }), {
        status: 409, headers: { "content-type": "application/json" },
      });
    }
    throw new Error("Unexpected database request: " + url);
  }) as typeof fetch;
  try {
    const response = await callWorker(new Request("https://sjelle.test/api/v1/driver/apply", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ city: "prishtina", mode: "ride" }),
    }), {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "test-publishable",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    });
    const body = await response.json() as { error: { code: string } };
    assert.equal(response.status, 409);
    assert.equal(body.error.code, "DRIVER_APPLICATION_EXISTS");
    assert.ok(requestedUrls.some(url => url.endsWith("/rpc/sjelle_apply_for_driver")));
    assert.ok(!requestedUrls.some(url => url.includes("/sjelle_driver_profiles?")));
    assert.ok(!requestedUrls.some(url => url.includes("/sjelle_user_roles")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("successful driver application returns pending status after atomic RPC succeeds", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
    if (url.endsWith("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }), { status: 200 });
    }
    if (url.includes("/sjelle_cities?slug=eq.prishtina")) {
      return new Response(JSON.stringify([{ id: "22222222-2222-4222-8222-222222222222", slug: "prishtina" }]), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/rpc/sjelle_apply_for_driver")) {
      return new Response(JSON.stringify({
        application_status: "pending",
        city_id: "22222222-2222-4222-8222-222222222222",
        mode: "ride",
        online: false,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error("Unexpected database request: " + url);
  }) as typeof fetch;
  try {
    const response = await callWorker(new Request("https://sjelle.test/api/v1/driver/apply", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ city: "prishtina", mode: "ride" }),
    }), {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "test-publishable",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    });
    const body = await response.json() as { data: { application_status: string; city: string; mode: string; online: boolean } };
    assert.equal(response.status, 201);
    assert.deepEqual(body.data, { application_status: "pending", city: "prishtina", mode: "ride", online: false });
    assert.ok(calls.some(call => call.url.endsWith("/rpc/sjelle_apply_for_driver") && call.method === "POST"));
    assert.equal(calls.some(call => call.url.includes("/sjelle_driver_profiles?") || call.url.includes("/sjelle_user_roles")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("driver readiness rejection from the job RPC is reported as a conflict", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }), { status: 200 });
    if (url.includes("/rpc/sjelle_driver_update_job")) return new Response(JSON.stringify({ message: "DRIVER_NOT_APPROVED" }), { status: 400, headers: { "content-type": "application/json" } });
    throw new Error("Unexpected database request: " + url);
  }) as typeof fetch;
  try {
    const response = await callWorker(new Request("https://sjelle.test/api/v1/driver/jobs/ride/33333333-3333-4333-8333-333333333333/status", { method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json" }, body: JSON.stringify({ status: "driver_arriving" }) }), {
      SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test-publishable", SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    });
    const body = await response.json() as { error: { code: string } };
    assert.equal(response.status, 409);
    assert.equal(body.error.code, "DRIVER_NOT_APPROVED");
  } finally { globalThis.fetch = originalFetch; }
});

test("cash collection rule violations from the job RPC return a conflict", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }), { status: 200 });
    if (url.includes("/rpc/sjelle_driver_update_job")) return new Response(JSON.stringify({ message: "CASH_COLLECTION_CONFIRMATION_REQUIRED" }), { status: 400, headers: { "content-type": "application/json" } });
    throw new Error("Unexpected database request: " + url);
  }) as typeof fetch;
  try {
    const response = await callWorker(new Request("https://sjelle.test/api/v1/driver/jobs/ride/33333333-3333-4333-8333-333333333333/status", { method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json" }, body: JSON.stringify({ status: "driver_arriving" }) }), {
      SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test-publishable", SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    });
    const body = await response.json() as { error: { code: string } };
    assert.equal(response.status, 409);
    assert.equal(body.error.code, "CASH_COLLECTION_CONFIRMATION_REQUIRED");
  } finally { globalThis.fetch = originalFetch; }
});

test("city activation requires an explicit positive readiness confirmation", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }), { status: 200 });
    if (url.includes("/sjelle_user_roles?") && url.includes("role=eq.admin")) return new Response(JSON.stringify([{ role: "admin" }]), { status: 200, headers: { "content-type": "application/json" } });
    throw new Error("Unexpected database request: " + url);
  }) as typeof fetch;
  try {
    const response = await callWorker(new Request("https://sjelle.test/api/v1/admin/cities/prishtina/services", {
      method: "PATCH",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ active: true, rides_enabled: true, food_enabled: false, confirm_ready: false, reason: "Readiness is not confirmed" }),
    }), {
      SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test-publishable", SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    });
    const body = await response.json() as { error: { code: string } };
    assert.equal(response.status, 400);
    assert.equal(body.error.code, "INVALID_CITY_ACTIVATION");
    assert.equal(requestedUrls.some(url => url.includes("/sjelle_cities?slug=")), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("city deactivation does not require a readiness confirmation", async () => {
  const originalFetch = globalThis.fetch;
  const cityId = "22222222-2222-4222-8222-222222222222";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }), { status: 200 });
    if (url.includes("/sjelle_user_roles?") && url.includes("role=eq.admin")) return new Response(JSON.stringify([{ role: "admin" }]), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/sjelle_cities?slug=eq.prishtina")) return new Response(JSON.stringify([{ id: cityId }]), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/sjelle_cities?id=eq." + cityId) && init?.method === "PATCH") return new Response(JSON.stringify([{ id: cityId, active: false, rides_enabled: false, food_enabled: false }]), { status: 200, headers: { "content-type": "application/json" } });
    if (url.endsWith("/sjelle_audit_logs") && init?.method === "POST") return new Response(null, { status: 201 });
    throw new Error("Unexpected database request: " + url);
  }) as typeof fetch;
  try {
    const response = await callWorker(new Request("https://sjelle.test/api/v1/admin/cities/prishtina/services", {
      method: "PATCH",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ active: false, rides_enabled: false, food_enabled: false, confirm_ready: false, reason: "Service temporarily paused" }),
    }), {
      SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test-publishable", SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    });
    const body = await response.json() as { data: { active: boolean; rides_enabled: boolean; food_enabled: boolean } };
    assert.equal(response.status, 200);
    assert.deepEqual(body.data, { id: cityId, active: false, rides_enabled: false, food_enabled: false });
  } finally { globalThis.fetch = originalFetch; }
});

test("city activation is blocked until a valid active service area exists", async () => {
  const originalFetch = globalThis.fetch;
  const cityId = "22222222-2222-4222-8222-222222222222";
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requestedUrls.push(url + " " + String(init?.method || "GET"));
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }), { status: 200 });
    if (url.includes("/sjelle_user_roles?") && url.includes("role=eq.admin")) return new Response(JSON.stringify([{ role: "admin" }]), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/sjelle_cities?slug=eq.prishtina")) return new Response(JSON.stringify([{ id: cityId }]), { status: 200, headers: { "content-type": "application/json" } });
    if (url.includes("/sjelle_service_areas?city_id=eq." + cityId)) return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    throw new Error("Unexpected database request: " + url + " " + String(init?.method || "GET"));
  }) as typeof fetch;
  try {
    const response = await callWorker(new Request("https://sjelle.test/api/v1/admin/cities/prishtina/services", {
      method: "PATCH",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ active: true, rides_enabled: true, food_enabled: false, confirm_ready: true, reason: "Pilot coverage is being prepared" }),
    }), {
      SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "test-publishable", SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    });
    const body = await response.json() as { error: { code: string } };
    assert.equal(response.status, 409);
    assert.equal(body.error.code, "NO_ACTIVE_SERVICE_AREA");
    assert.equal(requestedUrls.some(url => url.includes("/sjelle_cities?id=eq." + cityId) && url.includes("PATCH")), false);
  } finally { globalThis.fetch = originalFetch; }
});


test("admin driver queue returns pending documents, vehicles and driver applications", async () => {
  const originalFetch = globalThis.fetch;
  const userId = "11111111-1111-4111-8111-111111111111";
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: userId }), { status: 200 });
    if (url.includes("sjelle_user_roles?") && url.includes("role=eq.admin")) {
      return new Response(JSON.stringify([{ role: "admin" }]), { status: 200 });
    }
    if (url.includes("sjelle_driver_documents?review_status=eq.pending")) {
      return new Response(JSON.stringify([{ id: "doc-1", driver_id: userId, document_type: "identity", review_status: "pending" }]), { status: 200 });
    }
    if (url.includes("sjelle_vehicles?review_status=eq.pending")) {
      return new Response(JSON.stringify([{ id: "vehicle-1", driver_id: userId, vehicle_type: "standard", registration_number: "01-123-AA" }]), { status: 200 });
    }
    if (url.includes("sjelle_driver_profiles?review_status=eq.pending")) {
      return new Response(JSON.stringify([{ user_id: userId, city_id: "22222222-2222-4222-8222-222222222222", selected_mode: "ride" }]), { status: 200 });
    }
    throw new Error("Unexpected admin queue request: " + url);
  }) as typeof fetch;
  try {
    const response = await callWorker(new Request("https://sjelle.test/api/v1/admin/driver-documents", {
      headers: { authorization: "Bearer test-token" },
    }), {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "test-publishable",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    });
    const body = await response.json() as { data: { documents: Array<{ document_type: string }>; vehicles: Array<{ registration_number: string }>; drivers: Array<{ user_id: string }> } };
    assert.equal(response.status, 200);
    assert.equal(body.data.documents[0]?.document_type, "identity");
    assert.equal(body.data.vehicles[0]?.registration_number, "01-123-AA");
    assert.equal(body.data.drivers[0]?.user_id, userId);
    assert.ok(requestedUrls.some(url => url.includes("sjelle_driver_documents?review_status=eq.pending")));
    assert.ok(requestedUrls.some(url => url.includes("sjelle_vehicles?review_status=eq.pending")));
    assert.ok(requestedUrls.some(url => url.includes("sjelle_driver_profiles?review_status=eq.pending")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin driver queue denies non-admin users before reading application data", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }), { status: 200 });
    if (url.includes("sjelle_user_roles?") && url.includes("role=eq.admin")) return new Response("[]", { status: 200 });
    throw new Error("A non-admin must not read driver applications: " + url);
  }) as typeof fetch;
  try {
    const response = await callWorker(new Request("https://sjelle.test/api/v1/admin/driver-documents", {
      headers: { authorization: "Bearer test-token" },
    }), {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "test-publishable",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    });
    const body = await response.json() as { error: { code: string } };
    assert.equal(response.status, 403);
    assert.equal(body.error.code, "FORBIDDEN");
    assert.equal(requestedUrls.some(url => /sjelle_(driver_documents|vehicles|driver_profiles)\?/.test(url)), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("driver GPS updates reject inaccurate fixes before database writes", async () => {
  const originalFetch = globalThis.fetch;
  let databaseCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }), { status: 200 });
    databaseCalls += 1;
    throw new Error("An inaccurate GPS fix must be rejected before database access");
  }) as typeof fetch;
  try {
    const response = await callWorker(new Request("https://sjelle.test/api/v1/driver/location", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ latitude: 42.66, longitude: 21.16, accuracy_m: 1800 }),
    }), {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "test-publishable",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    });
    const body = await response.json() as { error: { code: string; message: string } };
    assert.equal(response.status, 422);
    assert.equal(body.error.code, "GPS_ACCURACY_TOO_LOW");
    assert.match(body.error.message, /1,500 metres or better/);
    assert.equal(databaseCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});



test("customer live-location requests require authentication before database access", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("Unauthenticated location requests must not reach Supabase");
  }) as typeof fetch;
  try {
    const response = await callWorker(new Request("https://sjelle.test/api/v1/rides/33333333-3333-4333-8333-333333333333/driver-location"), {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "test-publishable",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    });
    const body = await response.json() as { error: { code: string } };
    assert.equal(response.status, 401);
    assert.equal(body.error.code, "UNAUTHENTICATED");
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("customer live-location requests cannot read another customer's ride", async () => {
  const originalFetch = globalThis.fetch;
  const rideId = "33333333-3333-4333-8333-333333333333";
  const customerId = "11111111-1111-4111-8111-111111111111";
  let locationReads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: customerId }), { status: 200 });
    if (url.includes("sjelle_rides?id=eq." + rideId) && url.includes("customer_id=eq." + customerId)) {
      return new Response("[]", { status: 200 });
    }
    if (url.includes("sjelle_driver_locations?")) {
      locationReads += 1;
      throw new Error("A non-owner must never trigger a driver-location read");
    }
    throw new Error("Unexpected database request: " + url);
  }) as typeof fetch;
  try {
    const response = await callWorker(new Request("https://sjelle.test/api/v1/rides/" + rideId + "/driver-location", {
      headers: { authorization: "Bearer test-token" },
    }), {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "test-publishable",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    });
    const body = await response.json() as { error: { code: string } };
    assert.equal(response.status, 404);
    assert.equal(body.error.code, "RIDE_NOT_FOUND");
    assert.equal(locationReads, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("customer live-location requests stop exposing coordinates after a ride ends", async () => {
  const originalFetch = globalThis.fetch;
  const rideId = "33333333-3333-4333-8333-333333333333";
  const customerId = "11111111-1111-4111-8111-111111111111";
  const driverId = "22222222-2222-4222-8222-222222222222";
  let locationReads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: customerId }), { status: 200 });
    if (url.includes("sjelle_rides?id=eq." + rideId) && url.includes("customer_id=eq." + customerId)) {
      return new Response(JSON.stringify([{ id: rideId, driver_id: driverId, status: "completed" }]), { status: 200 });
    }
    if (url.includes("sjelle_driver_locations?")) {
      locationReads += 1;
      throw new Error("A terminal ride must not expose live coordinates");
    }
    throw new Error("Unexpected database request: " + url);
  }) as typeof fetch;
  try {
    const response = await callWorker(new Request("https://sjelle.test/api/v1/rides/" + rideId + "/driver-location", {
      headers: { authorization: "Bearer test-token" },
    }), {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "test-publishable",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    });
    const body = await response.json() as { data: { available: boolean } };
    assert.equal(response.status, 200);
    assert.deepEqual(body.data, { available: false });
    assert.equal(locationReads, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("customer live-location requests return only fresh coordinates for their active ride", async () => {
  const originalFetch = globalThis.fetch;
  const rideId = "33333333-3333-4333-8333-333333333333";
  const customerId = "11111111-1111-4111-8111-111111111111";
  const driverId = "22222222-2222-4222-8222-222222222222";
  let locationUrl = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: customerId }), { status: 200 });
    if (url.includes("sjelle_rides?id=eq." + rideId) && url.includes("customer_id=eq." + customerId)) {
      return new Response(JSON.stringify([{ id: rideId, driver_id: driverId, status: "driver_arriving" }]), { status: 200 });
    }
    if (url.includes("sjelle_driver_locations?")) {
      locationUrl = url;
      return new Response(JSON.stringify([{
        latitude: 42.3702,
        longitude: 21.1553,
        heading_degrees: 90,
        accuracy_m: 12,
        recorded_at: "2026-11-11T09:00:00Z",
        updated_at: new Date().toISOString(),
      }]), { status: 200 });
    }
    throw new Error("Unexpected database request: " + url);
  }) as typeof fetch;
  try {
    const response = await callWorker(new Request("https://sjelle.test/api/v1/rides/" + rideId + "/driver-location", {
      headers: { authorization: "Bearer test-token" },
    }), {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "test-publishable",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    });
    const body = await response.json() as { data: { available: boolean; latitude: number; longitude: number } };
    assert.equal(response.status, 200);
    assert.equal(body.data.available, true);
    assert.equal(body.data.latitude, 42.3702);
    assert.equal(body.data.longitude, 21.1553);
    assert.ok(locationUrl.includes("driver_id=eq." + driverId));
    assert.ok(locationUrl.includes("updated_at=gte."), "driver coordinates must be limited to the last two minutes");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("approved driver can request cancellation of an unstarted ride through the atomic job RPC", async () => {
  const originalFetch = globalThis.fetch;
  let rpcBody: Record<string, unknown> | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }), { status: 200 });
    }
    if (url.includes("/rpc/sjelle_driver_update_job")) {
      assert.equal(init?.method, "POST");
      rpcBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ job_id: "33333333-3333-4333-8333-333333333333", status: "cancelled_by_driver" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    throw new Error("Unexpected database request: " + url);
  }) as typeof fetch;
  try {
    const response = await callWorker(new Request("https://sjelle.test/api/v1/driver/jobs/ride/33333333-3333-4333-8333-333333333333/status", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ status: "cancelled_by_driver" }),
    }), {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "test-publishable",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    });
    const body = await response.json() as { data: { status: string } };
    assert.equal(response.status, 200);
    assert.equal(body.data.status, "cancelled_by_driver");
    assert.deepEqual(rpcBody, {
      p_driver_id: "11111111-1111-4111-8111-111111111111",
      p_job_kind: "ride",
      p_job_id: "33333333-3333-4333-8333-333333333333",
      p_next_status: "cancelled_by_driver",
      p_cash_collected: false,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("driver offer acceptance uses the authenticated driver identity and atomic RPC", async () => {
  const originalFetch = globalThis.fetch;
  const driverId = "11111111-1111-4111-8111-111111111111";
  const offerId = "33333333-3333-4333-8333-333333333333";
  const rideId = "44444444-4444-4444-8444-444444444444";
  let rpcBody: unknown = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: driverId }), { status: 200 });
    if (url.endsWith("/rpc/sjelle_respond_driver_offer")) {
      assert.equal(init?.method, "POST");
      rpcBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ status: "accepted", job_kind: "ride", job_id: rideId }), { status: 200 });
    }
    throw new Error("Unexpected database request: " + url);
  }) as typeof fetch;
  try {
    const response = await callWorker(new Request("https://sjelle.test/api/v1/driver/offers/" + offerId + "/respond", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ response: "accept", driver_id: "99999999-9999-4999-8999-999999999999" }),
    }), {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "test-publishable",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    });
    const body = await response.json() as { data: { status: string; job_kind: string; job_id: string } };
    assert.equal(response.status, 200);
    assert.deepEqual(rpcBody, { p_driver_id: driverId, p_offer_id: offerId, p_response: "accept" });
    assert.deepEqual(body.data, { status: "accepted", job_kind: "ride", job_id: rideId });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("driver offer acceptance reports atomic assignment conflicts without retrying as a new driver", async () => {
  const originalFetch = globalThis.fetch;
  const driverId = "11111111-1111-4111-8111-111111111111";
  const offerId = "33333333-3333-4333-8333-333333333333";
  let rpcCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: driverId }), { status: 200 });
    if (url.endsWith("/rpc/sjelle_respond_driver_offer")) {
      rpcCalls += 1;
      return new Response(JSON.stringify({ message: "DRIVER_NOT_AVAILABLE" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error("Unexpected database request: " + url);
  }) as typeof fetch;
  try {
    const response = await callWorker(new Request("https://sjelle.test/api/v1/driver/offers/" + offerId + "/respond", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ response: "accept" }),
    }), {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "test-publishable",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    });
    const body = await response.json() as { error: { code: string } };
    assert.equal(response.status, 409);
    assert.equal(body.error.code, "DRIVER_NOT_AVAILABLE");
    assert.equal(rpcCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("driver offer response rejects unsupported actions before database access", async () => {
  const originalFetch = globalThis.fetch;
  let databaseCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }), { status: 200 });
    databaseCalls += 1;
    throw new Error("Invalid offer actions must be rejected before database access");
  }) as typeof fetch;
  try {
    const response = await callWorker(new Request("https://sjelle.test/api/v1/driver/offers/33333333-3333-4333-8333-333333333333/respond", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ response: "cancel" }),
    }), {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "test-publishable",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    });
    const body = await response.json() as { error: { code: string } };
    assert.equal(response.status, 400);
    assert.equal(body.error.code, "INVALID_OFFER_RESPONSE");
    assert.equal(databaseCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("driver cancellation is not accepted for delivery jobs", async () => {
  const originalFetch = globalThis.fetch;
  let rpcCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }), { status: 200 });
    }
    if (url.includes("/rpc/")) rpcCalls += 1;
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  try {
    const response = await callWorker(new Request("https://sjelle.test/api/v1/driver/jobs/delivery/33333333-3333-4333-8333-333333333333/status", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ status: "cancelled_by_driver" }),
    }), {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "test-publishable",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    });
    const body = await response.json() as { error: { code: string } };
    assert.equal(response.status, 400);
    assert.equal(body.error.code, "INVALID_JOB_TRANSITION");
    assert.equal(rpcCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("rental booking maps the database exclusion constraint race to a date conflict", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (url.endsWith("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }), { status: 200 });
    }
    if (url.includes("/rest/v1/rental_vehicles?")) {
      return new Response(JSON.stringify([{
        id: "22222222-2222-4222-8222-222222222222",
        company_id: "44444444-4444-4444-8444-444444444444",
        owner_user_id: "55555555-5555-4555-8555-555555555555",
        daily_price_cents: 5000,
        deposit_cents: 10000,
      }]), { status: 200 });
    }
    if (url.includes("/rest/v1/rental_companies?")) return new Response(JSON.stringify([{ id: "44444444-4444-4444-8444-444444444444" }]), { status: 200 });
    if (url.includes("/rest/v1/rental_bookings?") && method === "GET") return new Response("[]", { status: 200 });
    if (url.includes("/rest/v1/rental_bookings?") && method === "POST") {
      return new Response(JSON.stringify({ code: "23P01", message: "conflicting key value violates exclusion constraint rental_bookings_no_active_overlap" }), {
        status: 409, headers: { "content-type": "application/json" },
      });
    }
    throw new Error("Unexpected database request: " + url);
  }) as typeof fetch;
  try {
    const response = await callWorker(new Request("https://sjelle.test/api/v1/rental-bookings", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({
        vehicle_id: "22222222-2222-4222-8222-222222222222",
        pickup_at: "2026-11-10T10:00:00.000Z",
        return_at: "2026-11-11T10:00:00.000Z",
      }),
    }), {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "test-publishable",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    });
    const body = await response.json() as { error: { code: string } };
    assert.equal(response.status, 409);
    assert.equal(body.error.code, "RENTAL_DATES_CONFLICT");
    assert.ok(calls.some(call => call.method === "POST" && call.url.includes("rental_bookings")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("driver cancellation after ride start is returned as a conflict from the database guard", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }), { status: 200 });
    }
    if (url.includes("/rpc/sjelle_driver_update_job")) {
      return new Response(JSON.stringify({ message: "DRIVER_CANCELLATION_NOT_ALLOWED" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }
    throw new Error("Unexpected database request: " + url);
  }) as typeof fetch;
  try {
    const response = await callWorker(new Request("https://sjelle.test/api/v1/driver/jobs/ride/33333333-3333-4333-8333-333333333333/status", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ status: "cancelled_by_driver" }),
    }), {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "test-publishable",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    });
    const body = await response.json() as { error: { code: string } };
    assert.equal(response.status, 409);
    assert.equal(body.error.code, "DRIVER_CANCELLATION_NOT_ALLOWED");
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("customer ride cancellation succeeds only through the customer-scoped database RPC", async () => {
  const originalFetch = globalThis.fetch;
  let rpcBody: Record<string, unknown> | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }), { status: 200 });
    }
    if (url.includes("/rpc/sjelle_cancel_ride")) {
      assert.equal(init?.method, "POST");
      rpcBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ id: "33333333-3333-4333-8333-333333333333", status: "cancelled_by_customer" }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    throw new Error("Unexpected database request: " + url);
  }) as typeof fetch;
  try {
    const response = await callWorker(new Request("https://sjelle.test/api/v1/rides/33333333-3333-4333-8333-333333333333/cancel", {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
    }), {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "test-publishable",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    });
    const body = await response.json() as { data: { status: string } };
    assert.equal(response.status, 200);
    assert.equal(body.data.status, "cancelled_by_customer");
    assert.deepEqual(rpcBody, {
      p_customer_id: "11111111-1111-4111-8111-111111111111",
      p_ride_id: "33333333-3333-4333-8333-333333333333",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("customer cancellation returns conflict after the ride is no longer cancellable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "11111111-1111-4111-8111-111111111111" }), { status: 200 });
    }
    if (url.includes("/rpc/sjelle_cancel_ride")) {
      return new Response(JSON.stringify({ message: "RIDE_NOT_CANCELLABLE" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }
    throw new Error("Unexpected database request: " + url);
  }) as typeof fetch;
  try {
    const response = await callWorker(new Request("https://sjelle.test/api/v1/rides/33333333-3333-4333-8333-333333333333/cancel", {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
    }), {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "test-publishable",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
    });
    const body = await response.json() as { error: { code: string } };
    assert.equal(response.status, 409);
    assert.equal(body.error.code, "RIDE_NOT_CANCELLABLE");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
