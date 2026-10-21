import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const apiPath = "apps/api/src/index.ts";
const edgePath = "supabase/functions/sjelle-api/index.ts";
const api = readFileSync(apiPath, "utf8");
const edge = readFileSync(edgePath, "utf8");

const expectedConflictCodes = [
  "DRIVER_NOT_APPROVED",
  "DRIVER_HAS_ACTIVE_JOB",
  "ORDER_NOT_READY_FOR_PICKUP",
  "INVALID_JOB_TRANSITION",
  "CASH_COLLECTION_CONFIRMATION_REQUIRED",
  "CASH_CONFIRMATION_ONLY_ON_COMPLETION",
  "INVALID_JOB_KIND",
];

function readConflictCodes(source, file) {
  const match = source.match(/const status = code === "JOB_NOT_FOUND" \? 404 : (\[[^\]]+\])\.includes\(code\) \? 409 : 503;/);
  assert.ok(match, `${file}: driver job conflict mapping is missing or changed unexpectedly`);
  return JSON.parse(match[1].replace(/\s+/g, ""));
}

for (const [file, source] of [[apiPath, api], [edgePath, edge]]) {
  assert.ok(source.includes("rpc/sjelle_apply_for_driver"), `${file}: driver application must use the atomic database RPC`);
  assert.ok(source.includes("rpc/sjelle_driver_update_job"), `${file}: driver job transitions must use the authoritative database RPC`);
  assert.ok(source.includes("CASH_COLLECTION_CONFIRMATION_REQUIRED"), `${file}: cash completion guard is missing`);
  assert.ok(source.includes("body.confirm_ready !== true"), `${file}: city activation must require positive readiness confirmation`);
  assert.deepEqual(readConflictCodes(source, file), expectedConflictCodes, `${file}: expected consistent job conflict codes`);
}

console.log("Critical API/Edge Function parity checks passed.");
