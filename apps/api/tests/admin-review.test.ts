import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";

const adminId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const driverId = "11111111-1111-4111-8111-111111111111";
const documentId = "22222222-2222-4222-8222-222222222222";
const vehicleId = "33333333-3333-4333-8333-333333333333";
const env = {
  APP_ENV: "test",
  ALLOWED_ORIGIN: "https://sjelle.example",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "test-publishable",
  SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
} as never;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function adminFetch(rpcName: string, rpcHandler: (body: Record<string, unknown>, headers: Headers) => Response, requests: string[]) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    requests.push(url + " " + (init?.method ?? "GET"));
    if (url.endsWith("/auth/v1/user")) return json({ id: adminId });
    if (url.includes("/rest/v1/sjelle_user_roles?") && url.includes("role=eq.admin")) return json([{ role: "admin" }]);
    if (url.includes("/rest/v1/rpc/" + rpcName)) {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer service-test-key");
      assert.equal(init?.method, "POST");
      return rpcHandler(JSON.parse(String(init?.body || "{}")) as Record<string, unknown>, headers);
    }
    throw new Error("Unexpected database request: " + url);
  };
}

test("admin driver review uses the atomic service-role RPC and returns the audited offline state", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  let rpcBody: Record<string, unknown> | null = null;
  globalThis.fetch = adminFetch("sjelle_admin_review_driver", body => {
    rpcBody = body;
    return json({ user_id: driverId, review_status: "approved", online: false });
  }, requests);
  try {
    const response = await worker.fetch(new Request("https://sjelle.test/api/v1/admin/drivers/" + driverId + "/review", {
      method: "PATCH", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
      body: JSON.stringify({ review_status: "approved" }),
    }), env);
    const body = await response.json() as { data?: { user_id: string; review_status: string; online: boolean } };
    assert.equal(response.status, 200);
    assert.deepEqual(body.data, { user_id: driverId, review_status: "approved", online: false });
    assert.equal(rpcBody?.p_actor_id, adminId);
    assert.equal(rpcBody?.p_driver_id, driverId);
    assert.equal(rpcBody?.p_review_status, "approved");
    assert.equal(requests.some(item => item.includes("/sjelle_driver_profiles?") && item.includes("PATCH")), false);
    assert.equal(requests.some(item => item.includes("/sjelle_audit_logs")), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("admin driver approval maps missing latest mandatory evidence to a conflict", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = adminFetch("sjelle_admin_review_driver", () => json({ message: "DRIVER_DOCUMENTS_NOT_APPROVED" }, 400), requests);
  try {
    const response = await worker.fetch(new Request("https://sjelle.test/api/v1/admin/drivers/" + driverId + "/review", {
      method: "PATCH", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
      body: JSON.stringify({ review_status: "approved" }),
    }), env);
    const body = await response.json() as { error?: { code?: string } };
    assert.equal(response.status, 409);
    assert.equal(body.error?.code, "DRIVER_DOCUMENTS_NOT_APPROVED");
    assert.equal(requests.filter(item => item.includes("/rest/v1/rpc/sjelle_admin_review_driver")).length, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("admin document review sends a bounded rejection reason to the atomic RPC", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  let rpcBody: Record<string, unknown> | null = null;
  globalThis.fetch = adminFetch("sjelle_admin_review_driver_document", body => {
    rpcBody = body;
    return json({ id: documentId, document_type: "identity", review_status: "rejected" });
  }, requests);
  try {
    const response = await worker.fetch(new Request("https://sjelle.test/api/v1/admin/driver-documents/" + documentId + "/review", {
      method: "PATCH", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
      body: JSON.stringify({ review_status: "rejected", rejection_reason: "  " + "x".repeat(400) + "  " }),
    }), env);
    const body = await response.json() as { data?: { id: string; document_type: string; review_status: string } };
    assert.equal(response.status, 200);
    assert.deepEqual(body.data, { id: documentId, document_type: "identity", review_status: "rejected" });
    assert.equal(rpcBody?.p_actor_id, adminId);
    assert.equal(rpcBody?.p_document_id, documentId);
    assert.equal(rpcBody?.p_review_status, "rejected");
    assert.equal(String(rpcBody?.p_rejection_reason).length, 300);
    assert.equal(requests.some(item => item.includes("/sjelle_driver_documents?") && item.includes("PATCH")), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("admin document review maps expired evidence to a conflict", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = adminFetch("sjelle_admin_review_driver_document", () => json({ message: "DOCUMENT_EXPIRED" }, 400), requests);
  try {
    const response = await worker.fetch(new Request("https://sjelle.test/api/v1/admin/driver-documents/" + documentId + "/review", {
      method: "PATCH", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
      body: JSON.stringify({ review_status: "approved" }),
    }), env);
    const body = await response.json() as { error?: { code?: string } };
    assert.equal(response.status, 409);
    assert.equal(body.error?.code, "DOCUMENT_EXPIRED");
  } finally { globalThis.fetch = originalFetch; }
});

test("admin vehicle review validates calendar expiry and uses the atomic RPC", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  let rpcBody: Record<string, unknown> | null = null;
  globalThis.fetch = adminFetch("sjelle_admin_review_vehicle", body => {
    rpcBody = body;
    return json({ id: vehicleId, review_status: "approved" });
  }, requests);
  try {
    const invalidDate = await worker.fetch(new Request("https://sjelle.test/api/v1/admin/vehicles/" + vehicleId + "/review", {
      method: "PATCH", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
      body: JSON.stringify({ review_status: "approved", document_expires_at: "2026-02-31" }),
    }), env);
    assert.equal(invalidDate.status, 400);
    assert.equal(requests.some(item => item.includes("/rest/v1/rpc/sjelle_admin_review_vehicle")), false);

    const response = await worker.fetch(new Request("https://sjelle.test/api/v1/admin/vehicles/" + vehicleId + "/review", {
      method: "PATCH", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
      body: JSON.stringify({ review_status: "approved", document_expires_at: "2027-12-31" }),
    }), env);
    const body = await response.json() as { data?: { id: string; review_status: string } };
    assert.equal(response.status, 200);
    assert.deepEqual(body.data, { id: vehicleId, review_status: "approved" });
    assert.equal(rpcBody?.p_actor_id, adminId);
    assert.equal(rpcBody?.p_vehicle_id, vehicleId);
    assert.equal(rpcBody?.p_review_status, "approved");
    assert.equal(rpcBody?.p_document_expires_at, "2027-12-31");
  } finally { globalThis.fetch = originalFetch; }
});

test("admin vehicle review maps expired vehicle evidence to a conflict", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = adminFetch("sjelle_admin_review_vehicle", () => json({ message: "VEHICLE_DOCUMENT_EXPIRED" }, 400), requests);
  try {
    const response = await worker.fetch(new Request("https://sjelle.test/api/v1/admin/vehicles/" + vehicleId + "/review", {
      method: "PATCH", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
      body: JSON.stringify({ review_status: "approved", document_expires_at: "2026-01-01" }),
    }), env);
    const body = await response.json() as { error?: { code?: string } };
    assert.equal(response.status, 409);
    assert.equal(body.error?.code, "VEHICLE_DOCUMENT_EXPIRED");
  } finally { globalThis.fetch = originalFetch; }
});

test("non-admin review requests are rejected before any review RPC", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/auth/v1/user")) return json({ id: adminId });
    if (url.includes("/rest/v1/sjelle_user_roles?")) return json([]);
    throw new Error("Review RPC must not run for a non-admin: " + url);
  };
  try {
    const response = await worker.fetch(new Request("https://sjelle.test/api/v1/admin/drivers/" + driverId + "/review", {
      method: "PATCH", headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
      body: JSON.stringify({ review_status: "approved" }),
    }), env);
    const body = await response.json() as { error?: { code?: string } };
    assert.equal(response.status, 403);
    assert.equal(body.error?.code, "FORBIDDEN");
    assert.equal(requests.some(url => url.includes("/rpc/")), false);
  } finally { globalThis.fetch = originalFetch; }
});
