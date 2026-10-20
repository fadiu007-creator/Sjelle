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

test("CORS preflight is empty and only reflects the configured origin", async () => {
  const allowed = await worker.fetch(new Request("https://api.example/api/v1/rides", {
    method: "OPTIONS",
    headers: { origin: "https://sjelle.example", "access-control-request-method": "POST" },
  }), env, {} as never);
  assert.equal(allowed.status, 204);
  assert.equal(await allowed.text(), "");
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://sjelle.example");

  const denied = await worker.fetch(new Request("https://api.example/api/v1/rides", {
    method: "OPTIONS",
    headers: { origin: "https://attacker.example", "access-control-request-method": "POST" },
  }), env, {} as never);
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
});

test("oversized API bodies are rejected before parsing or backend access", async () => {
  const body = new Uint8Array(2 * 1024 * 1024 + 1);
  const request = new Request("https://api.example/api/v1/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(body.byteLength) },
    body,
  });
  const result = await worker.fetch(request, env, {} as never);
  assert.equal(result.status, 413);
  const payload = await result.json() as { error?: { code?: string } };
  assert.equal(payload.error?.code, "REQUEST_TOO_LARGE");
});
