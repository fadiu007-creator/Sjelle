import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";

const env = {
  APP_ENV: "test",
  ALLOWED_ORIGIN: "https://sjelle.example",
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "public-test-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
} as never;

const adminId = "00000000-0000-4000-8000-000000000099";
const driverId = "00000000-0000-4000-8000-000000000098";
const handoverId = "00000000-0000-4000-8000-000000000097";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("cash balances require an authenticated admin", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return json({ message: "unexpected backend request" }, 500);
  };
  try {
    const response = await worker.fetch(new Request("https://api.example/api/v1/admin/cash-balances"), env);
    assert.equal(response.status, 401);
    assert.equal((await response.json() as { error?: { code?: string } }).error?.code, "UNAUTHENTICATED");
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cash balances require an authenticated admin role and validate the RPC response", async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith("/auth/v1/user")) return json({ id: adminId });
    if (url.includes("/rest/v1/sjelle_user_roles?")) return json([{ role: "admin" }]);
    if (url.includes("/rest/v1/rpc/sjelle_admin_driver_cash_balances")) {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer service-test-key");
      return json([{
        driver_id: driverId,
        review_status: "approved",
        city_id: null,
        online: false,
        balance_cents: "2750",
        last_collection_at: "2026-11-24T08:00:00.000Z",
      }]);
    }
    throw new Error("Unexpected request: " + url);
  };
  try {
    const response = await worker.fetch(new Request("https://api.example/api/v1/admin/cash-balances", {
      headers: { authorization: "Bearer admin-token" },
    }), env);
    const body = await response.json() as { data?: Array<{ driver_id: string; balance_cents: number }> };
    assert.equal(response.status, 200);
    assert.equal(body.data?.length, 1);
    assert.equal(body.data?.[0]?.driver_id, driverId);
    assert.equal(body.data?.[0]?.balance_cents, 2750);
    assert.ok(requested.some(url => url.includes("role=eq.admin")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("non-admin users cannot read driver cash balances or create handovers", async () => {
  const originalFetch = globalThis.fetch;
  let rpcCalls = 0;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) return json({ id: adminId });
    if (url.includes("/rest/v1/sjelle_user_roles?")) return json([]);
    if (url.includes("/rest/v1/rpc/")) rpcCalls += 1;
    return json([]);
  };
  try {
    const balances = await worker.fetch(new Request("https://api.example/api/v1/admin/cash-balances", {
      headers: { authorization: "Bearer user-token" },
    }), env);
    const handover = await worker.fetch(new Request("https://api.example/api/v1/admin/cash-handovers", {
      method: "POST",
      headers: { authorization: "Bearer user-token", "content-type": "application/json", "idempotency-key": "handover-key-123" },
      body: JSON.stringify({ driver_id: driverId, amount_cents: 1000 }),
    }), env);
    assert.equal(balances.status, 403);
    assert.equal(handover.status, 403);
    assert.equal(rpcCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cash handover rejects unsafe amounts and missing idempotency keys before the RPC", async () => {
  const originalFetch = globalThis.fetch;
  let rpcCalls = 0;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) return json({ id: adminId });
    if (url.includes("/rest/v1/sjelle_user_roles?")) return json([{ role: "admin" }]);
    if (url.includes("/rest/v1/rpc/sjelle_record_driver_cash_handover")) rpcCalls += 1;
    return json([]);
  };
  try {
    const fractional = await worker.fetch(new Request("https://api.example/api/v1/admin/cash-handovers", {
      method: "POST",
      headers: { authorization: "Bearer admin-token", "content-type": "application/json", "idempotency-key": "handover-key-123" },
      body: JSON.stringify({ driver_id: driverId, amount_cents: 100.5 }),
    }), env);
    const missingKey = await worker.fetch(new Request("https://api.example/api/v1/admin/cash-handovers", {
      method: "POST",
      headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
      body: JSON.stringify({ driver_id: driverId, amount_cents: 100 }),
    }), env);
    assert.equal(fractional.status, 400);
    assert.equal((await fractional.json() as { error?: { code?: string } }).error?.code, "INVALID_CASH_HANDOVER");
    assert.equal(missingKey.status, 400);
    assert.equal(rpcCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin cash handover uses the idempotent service-role RPC and returns the balanced snapshot", async () => {
  const originalFetch = globalThis.fetch;
  const rpcBodies: Record<string, unknown>[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) return json({ id: adminId });
    if (url.includes("/rest/v1/sjelle_user_roles?")) return json([{ role: "admin" }]);
    if (url.includes("/rest/v1/rpc/sjelle_record_driver_cash_handover")) {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer service-test-key");
      assert.equal(init?.method, "POST");
      rpcBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({
        id: handoverId,
        driver_id: driverId,
        amount_cents: 1500,
        currency: "EUR",
        balance_before_cents: 2750,
        balance_after_cents: 1250,
        reference: "receipt-42",
        replayed: false,
      });
    }
    throw new Error("Unexpected request: " + url);
  };
  try {
    const response = await worker.fetch(new Request("https://api.example/api/v1/admin/cash-handovers", {
      method: "POST",
      headers: {
        authorization: "Bearer admin-token",
        "content-type": "application/json",
        "idempotency-key": "handover-key-123",
      },
      body: JSON.stringify({ driver_id: driverId, amount_cents: 1500, reference: "receipt-42" }),
    }), env);
    const body = await response.json() as { data?: { balance_after_cents: number; replayed: boolean } };
    assert.equal(response.status, 200);
    assert.equal(body.data?.balance_after_cents, 1250);
    assert.equal(body.data?.replayed, false);
    assert.equal(rpcBodies[0]?.p_actor_id, adminId);
    assert.equal(rpcBodies[0]?.p_driver_id, driverId);
    assert.equal(rpcBodies[0]?.p_amount_cents, 1500);
    assert.equal(rpcBodies[0]?.p_idempotency_key, "handover-key-123");
    assert.equal(rpcBodies[0]?.p_reference, "receipt-42");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cash handover rejects an amount above the driver's ledger balance", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.endsWith("/auth/v1/user")) return json({ id: adminId });
    if (url.includes("/rest/v1/sjelle_user_roles?")) return json([{ role: "admin" }]);
    if (url.includes("/rest/v1/rpc/sjelle_record_driver_cash_handover")) return json({ message: "CASH_HANDOVER_EXCEEDS_BALANCE" }, 400);
    throw new Error("Unexpected request: " + url);
  };
  try {
    const response = await worker.fetch(new Request("https://api.example/api/v1/admin/cash-handovers", {
      method: "POST",
      headers: { authorization: "Bearer admin-token", "content-type": "application/json", "idempotency-key": "handover-key-123" },
      body: JSON.stringify({ driver_id: driverId, amount_cents: 5000 }),
    }), env);
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { error?: { code?: string } }).error?.code, "CASH_HANDOVER_EXCEEDS_BALANCE");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
