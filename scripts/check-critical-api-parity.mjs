import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const apiPath = "apps/api/src/index.ts";
const edgePath = "supabase/functions/sjelle-api/index.ts";
const api = readFileSync(apiPath, "utf8");
const edge = readFileSync(edgePath, "utf8");
const adminJs = readFileSync("apps/customer/admin/admin.js", "utf8");
const adminHtml = readFileSync("apps/customer/admin/index.html", "utf8");

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
  assert.ok(source.includes("(body.active && body.confirm_ready !== true)"), `${file}: activation must require readiness confirmation while deactivation stays available`);
  assert.deepEqual(readConflictCodes(source, file), expectedConflictCodes, `${file}: expected consistent job conflict codes`);
}

assert.ok(adminJs.includes("cityConfirmInput.required=cityActiveInput.checked"), "admin portal must require readiness confirmation only when activating a city");
assert.ok(adminJs.includes("if(!cityActiveInput.checked)cityConfirmInput.checked=false"), "deactivating a city must clear readiness confirmation");
assert.ok(!adminHtml.includes('name="confirm_ready" type="checkbox" required'), "readiness confirmation must not block safe deactivation in HTML");
assert.ok(adminHtml.includes('id="city-readiness"'), "admin portal must expose a city readiness summary");
assert.ok(adminJs.includes("function renderCityReadiness()"), "admin portal must render the city readiness summary");
assert.ok(adminJs.includes("currentCity.pricing?.active"), "readiness summary must check active city pricing");
assert.ok(adminJs.includes("function isUsableServiceAreaGeometry(value)"), "readiness summary must validate service-area geometry");
assert.ok(adminJs.includes("Math.abs(first[0]-last[0])>1e-6"), "readiness summary must reject unclosed GeoJSON rings");
assert.ok(adminJs.includes("point[0]<19.7||point[0]>22||point[1]<41.7||point[1]>43.4"), "readiness summary must reject coordinates outside the configured Kosovo bounds");

console.log("Critical API/Edge Function and admin activation parity checks passed.");
