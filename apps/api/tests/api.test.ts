import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";

const callWorker = (request: Request, env: Parameters<typeof worker.fetch>[1]) =>
  worker.fetch(request, env, {} as ExecutionContext);

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
  const response = await callWorker(new Request("https://sjelle.test/api/v1/rides"), {});
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
