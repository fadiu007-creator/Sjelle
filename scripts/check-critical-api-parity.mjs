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
  "DRIVER_CANCELLATION_NOT_ALLOWED",
  "CASH_COLLECTION_CONFIRMATION_REQUIRED",
  "CASH_CONFIRMATION_ONLY_ON_COMPLETION",
  "CASH_CONFIRMATION_NOT_APPLICABLE",
  "ONLINE_PAYMENT_NOT_CONFIGURED",
  "INVALID_JOB_KIND",
];

function readConflictCodes(source, file) {
  const match = source.match(/const status = code === "JOB_NOT_FOUND" \? 404 : (\[[^\]]+\])\.includes\(code\) \? 409 : 503;/);
  assert.ok(match, `${file}: driver job conflict mapping is missing or changed unexpectedly`);
  return JSON.parse(match[1].replace(/\s+/g, ""));
}

for (const [file, source] of [[apiPath, api], [edgePath, edge]]) {
  assert.ok(source.includes("rpc/sjelle_set_driver_availability_with_location"), `${file}: online GPS and availability must be committed through the atomic database RPC`);
  assert.ok(source.includes("rpc/sjelle_update_driver_location_if_online"), `${file}: live GPS refresh must lock and recheck online state in the database`);
  assert.ok(source.includes("DRIVER_OFFLINE"), `${file}: offline drivers must not be allowed to update precise GPS location`);
  assert.ok(source.includes("&and=(recorded_at.gte."), `${file}: customer tracking must require a fresh recorded GPS fix`);
  assert.ok(source.includes("&accuracy_m=lte.1500"), `${file}: customer tracking must reject inaccurate GPS fixes`);
  assert.ok(source.includes("recordedAt >= now - 120000") && source.includes("recordedAt <= now + 15000"), `${file}: customer tracking must fail closed on stale or future-dated GPS timestamps`);
  assert.ok(source.includes("rpc/sjelle_apply_for_driver"), `${file}: driver application must use the atomic database RPC`);
  assert.ok(source.includes("rpc/sjelle_driver_update_job"), `${file}: driver job transitions must use the authoritative database RPC`);
  assert.ok(source.includes("CASH_COLLECTION_CONFIRMATION_REQUIRED"), `${file}: cash completion guard is missing`);
  assert.ok(source.includes("CASH_CONFIRMATION_NOT_APPLICABLE"), `${file}: online jobs must not be marked as cash-collected`);
  assert.ok(source.includes("ONLINE_PAYMENT_NOT_CONFIGURED"), `${file}: online jobs must fail closed until a payment provider is configured`);
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

const cashMigration = readFileSync("supabase/migrations/20261108082418_sjelle_payment_method_cash_guard.sql", "utf8");
assert.ok(cashMigration.includes("v_ride.payment_method='cash'"), "cash migration must guard ride completion by payment method");
assert.ok(cashMigration.includes("v_order.payment_method='cash'"), "cash migration must guard delivery completion by payment method");
assert.ok(cashMigration.includes("'not_due'::public.sjelle_cash_status"), "online jobs must not remain in the cash-due ledger state");

const driverLocationMigration = readFileSync("supabase/migrations/20261114091207_sjelle_atomic_driver_location_availability.sql", "utf8");
assert.ok(driverLocationMigration.includes("delete from public.sjelle_driver_locations"), "going offline must delete the driver's precise GPS row");
assert.ok(driverLocationMigration.includes("sjelle_set_driver_availability_with_location"), "online availability must persist GPS and status atomically");
assert.ok(driverLocationMigration.includes("grant execute on function public.sjelle_set_driver_availability_with_location"), "only the service role may execute the atomic availability RPC");
assert.ok(driverLocationMigration.includes("sjelle_update_driver_location_if_online"), "live GPS refresh must serialize with offline transitions");
assert.ok(driverLocationMigration.includes("grant execute on function public.sjelle_update_driver_location_if_online"), "only the service role may execute the live GPS RPC");

const serializedLocationMigration = readFileSync("supabase/migrations/20261114093553_sjelle_serialize_driver_gps_transitions.sql", "utf8");
const availabilityWrapperStart = serializedLocationMigration.indexOf("create or replace function public.sjelle_set_driver_availability_with_location");
const availabilityWrapperEnd = serializedLocationMigration.indexOf("$function$;", availabilityWrapperStart);
assert.ok(availabilityWrapperStart >= 0 && availabilityWrapperEnd > availabilityWrapperStart, "serialized availability migration must define the atomic location RPC");
const availabilityWrapper = serializedLocationMigration.slice(availabilityWrapperStart, availabilityWrapperEnd);
const profileLockPosition = availabilityWrapper.indexOf("for update");
const locationWritePosition = availabilityWrapper.indexOf("insert into public.sjelle_driver_locations");
assert.ok(profileLockPosition >= 0 && locationWritePosition > profileLockPosition, "availability must lock the driver profile before writing precise GPS to avoid lock-order deadlocks");
assert.ok(availabilityWrapper.includes("DRIVER_APPLICATION_REQUIRED"), "availability must reject users without a driver profile before writing GPS");
assert.ok(availabilityWrapper.includes("return public.sjelle_set_driver_availability(p_driver_id, p_online, p_mode)"), "availability must preserve the authoritative readiness and active-job checks");

const onlinePaymentMigration = readFileSync("supabase/migrations/20261108083041_sjelle_block_unconfigured_online_payments.sql", "utf8");
assert.ok(onlinePaymentMigration.includes("v_ride.payment_method='online'"), "online rides must fail closed until payment is configured");
assert.ok(onlinePaymentMigration.includes("v_order.payment_method='online'"), "online deliveries must fail closed until payment is configured");


const assignmentGateMigration = readFileSync("supabase/migrations/20261115081948_sjelle_revalidate_driver_assignment_eligibility.sql", "utf8");
assert.ok(assignmentGateMigration.includes("create or replace function public.sjelle_guard_driver_assignment()"), "assignment gate migration must replace the shared ride/delivery assignment guard");
assert.ok(assignmentGateMigration.includes("for update"), "assignment guard must lock the driver profile while validating eligibility");
assert.ok(assignmentGateMigration.includes("v_profile.city_id is distinct from v_city_id"), "assignment must keep driver and job in the same city");
assert.ok(assignmentGateMigration.includes("c.active"), "assignment must reject inactive cities");
assert.ok(assignmentGateMigration.includes("c.rides_enabled"), "ride assignment must re-check the city ride switch");
assert.ok(assignmentGateMigration.includes("c.food_enabled"), "delivery assignment must re-check the city food switch");
assert.ok(assignmentGateMigration.includes("document_type in ('identity', 'driving_licence', 'vehicle_registration', 'insurance')"), "assignment must require all four mandatory driver document types");
assert.ok(assignmentGateMigration.includes("order by document_type, created_at desc, id desc"), "assignment must evaluate the latest document for each type deterministically");
assert.ok(assignmentGateMigration.includes("v_approved_document_count <> 4"), "assignment must fail closed when any required document is missing, pending, rejected or expired");
assert.ok(assignmentGateMigration.includes("v.vehicle_type = v_vehicle_type"), "ride assignment must match an approved vehicle to the requested class");
assert.ok(assignmentGateMigration.includes("v.document_expires_at >= current_date"), "assignment must reject expired vehicle documents");
assert.ok(assignmentGateMigration.includes("l.recorded_at >= now() - interval '2 minutes'"), "assignment must require a fresh GPS fix");
assert.ok(assignmentGateMigration.includes("l.accuracy_m <= 1500"), "assignment must reject inaccurate GPS fixes");
assert.ok(assignmentGateMigration.includes("DRIVER_HAS_ACTIVE_JOB"), "assignment must preserve cross-service exclusive driver assignment");
assert.ok(assignmentGateMigration.includes("revoke all on function public.sjelle_guard_driver_assignment() from public, anon, authenticated"), "assignment guard must not be executable by untrusted client roles");
assert.ok(assignmentGateMigration.includes("grant execute on function public.sjelle_guard_driver_assignment() to service_role"), "assignment guard must remain service-role only");

console.log("Driver assignment eligibility migration assertions passed.");


const readinessSerializationMigration = readFileSync("supabase/migrations/20261115082354_sjelle_serialize_readiness_evidence_changes.sql", "utf8");
assert.ok(readinessSerializationMigration.includes("create or replace function public.sjelle_lock_driver_readiness_profile()"), "readiness evidence writes must use a shared profile-lock trigger");
assert.ok(readinessSerializationMigration.includes("before insert or update or delete on public.sjelle_driver_documents"), "document uploads, reviews and removals must serialize with assignment");
assert.ok(readinessSerializationMigration.includes("before insert or update or delete on public.sjelle_vehicles"), "vehicle registration and review changes must serialize with assignment");
assert.ok(readinessSerializationMigration.includes("from public.sjelle_driver_profiles") && readinessSerializationMigration.includes("for update"), "readiness changes must acquire the driver profile row lock");
assert.ok(readinessSerializationMigration.includes("order by driver_id"), "ownership corrections must lock old/new driver profiles in stable order");
assert.ok(readinessSerializationMigration.includes("revoke all on function public.sjelle_lock_driver_readiness_profile() from public, anon, authenticated"), "readiness lock helper must not be directly executable by client roles");

console.log("Driver readiness evidence serialization assertions passed.");
