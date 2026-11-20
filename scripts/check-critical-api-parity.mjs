import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const apiPath = "apps/api/src/index.ts";
const edgePath = "supabase/functions/sjelle-api/index.ts";
const api = readFileSync(apiPath, "utf8");
const edge = readFileSync(edgePath, "utf8");
const adminJs = readFileSync("apps/customer/admin/admin.js", "utf8");
const adminHtml = readFileSync("apps/customer/admin/index.html", "utf8");
const driverJs = readFileSync("apps/customer/driver/driver.js", "utf8");
const driverHtml = readFileSync("apps/customer/driver/index.html", "utf8");
const portalCss = readFileSync("apps/customer/portal.css", "utf8");

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
  assert.ok(source.includes("&and=(recorded_at.lte.") && source.includes("accuracy_m.lte.1500") && source.includes("latitude.gte.41.7"), `${file}: online readiness preflight must reject stale, out-of-area or inaccurate stored GPS fixes`);
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

const availabilityReadinessMigration = readFileSync("supabase/migrations/20261120084240_sjelle_driver_availability_readiness_consistency.sql", "utf8");
assert.ok(availabilityReadinessMigration.includes("order by document_type, created_at desc, id desc"), "online readiness must select the same deterministic latest document as dispatch");
assert.ok(availabilityReadinessMigration.includes("and accuracy_m between 0 and 1500"), "online readiness must reject GPS fixes outside the dispatch accuracy limit");
assert.ok(availabilityReadinessMigration.includes("and recorded_at <= now() + interval '15 seconds'"), "online readiness must reject future-dated GPS fixes");
assert.ok(availabilityReadinessMigration.includes("and latitude between 41.7 and 43.4") && availabilityReadinessMigration.includes("and longitude between 19.7 and 22.0"), "online readiness must enforce Kosovo coordinate bounds");
assert.ok(availabilityReadinessMigration.includes("sjelle_driver_documents_latest_evidence_idx"), "latest driver evidence lookup must have a matching composite index");
assert.ok(availabilityReadinessMigration.includes("new.review_status is distinct from 'approved'"), "unapproved driver profiles must be forced offline");
assert.ok(availabilityReadinessMigration.includes("delete from public.sjelle_driver_locations"), "offline or unapproved profile updates must purge precise GPS");
assert.ok(availabilityReadinessMigration.includes("create trigger sjelle_enforce_driver_location_privacy"), "driver location privacy must be enforced for direct administrative profile updates");

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


const reconciliationMigration = readFileSync("supabase/migrations/20261117082811_sjelle_admin_reconciliation_keyset_pagination.sql", "utf8");
for (const [file, source] of [[apiPath, api], [edgePath, edge]]) {
  assert.ok(source.includes("rpc/sjelle_admin_reconciliation_page"), `${file}: admin reconciliation must use the bounded database keyset RPC`);
  assert.ok(!source.includes("sjelle_ledger_entries?select=id,related_ride_id"), `${file}: admin reconciliation must not read a fixed 1,000-row table window`);
}
assert.ok(reconciliationMigration.includes("create or replace function public.sjelle_admin_reconciliation_page"), "reconciliation migration must provide the paginated summary RPC");
assert.ok(reconciliationMigration.includes("order by created_at desc, id desc"), "reconciliation pages must use a deterministic keyset order");
assert.ok(reconciliationMigration.includes("revoke all on function public.sjelle_admin_reconciliation_page"), "reconciliation RPC must revoke public/client execution");
assert.ok(reconciliationMigration.includes("grant execute on function public.sjelle_admin_reconciliation_page"), "reconciliation RPC must be callable by the trusted service role only");
assert.ok(adminJs.includes("reconciliationPageCursors") && adminJs.includes("Më të vjetra") && adminJs.includes("Më të reja"), "admin reconciliation UI must support cursor-based next/previous pages");
assert.ok(adminHtml.includes('id="reconciliation-pagination"'), "admin reconciliation UI must provide a pagination control region");

console.log("Admin reconciliation keyset pagination assertions passed.");

for (const [file, source] of [[apiPath, api], [edgePath, edge]]) {
  assert.ok(source.includes('encodeURIComponent(driverReviewMatch[1]) + "&select=id,document_type,review_status,expires_at,created_at&order=created_at.desc,id.desc"'), `${file}: admin driver approval must fetch document IDs and use deterministic ordering`);
  assert.ok(source.includes("const aId = String(a.id).toLowerCase()"), `${file}: latest driver documents must have a deterministic ID tie-break`);
}
assert.ok(driverJs.includes('const required=[["identity","Dokument identiteti"]'), "driver portal must list all mandatory document types");
assert.ok(driverJs.includes('status="missing"') && driverJs.includes('status=expired?"expired"'), "driver portal must distinguish missing and expired evidence");
assert.ok(driverHtml.includes('id="document-requirements"'), "driver portal must render a visible document readiness checklist");
assert.ok(driverHtml.includes('driver-document-readiness-20261117'), "driver portal must invalidate cached assets for the readiness workflow");
assert.ok(portalCss.includes(".portal-status.expired") && portalCss.includes(".portal-status.missing"), "driver portal must visually distinguish expired and missing documents");

console.log("Driver document readiness API, Edge Function and portal assertions passed.");

for (const [file, source] of [[apiPath, api], [edgePath, edge]]) {
  assert.ok(source.includes("function buildDriverReadiness("), `${file}: admin driver readiness aggregation is missing`);
  assert.ok(source.includes("sjelle_driver_profiles?select=user_id,city_id,selected_mode,review_status,online,created_at,updated_at&order=updated_at.desc,user_id.desc"), `${file}: admin readiness must inspect all driver profile states`);
  assert.ok(source.includes("sjelle_driver_documents?select=id,driver_id,document_type,review_status,expires_at,created_at,rejection_reason&order=created_at.desc,id.desc"), `${file}: admin readiness must use latest document evidence without exposing storage paths`);
  assert.ok(source.includes("sjelle_vehicles?select=id,driver_id,vehicle_type,make,model,color,review_status,document_expires_at,created_at&order=created_at.desc,id.desc"), `${file}: admin readiness must include approved, pending and rejected vehicle states`);
  assert.ok(source.includes("possiblyTruncated"), `${file}: admin readiness must disclose when its bounded evidence reads may be incomplete`);
}
assert.ok(adminJs.includes("function renderDriverReadiness(rows,meta)"), "admin portal must render readiness for every driver profile state");
assert.ok(adminJs.includes('driver.evidence_ready?"e plotë":"e paplotë"'), "admin portal must distinguish evidence completeness from profile approval");
assert.ok(adminHtml.includes('id="driver-readiness"'), "admin portal must expose the all-driver readiness panel");
console.log("All-driver admin readiness API, Edge Function and portal parity checks passed.");

for (const [file, source] of [[apiPath, api], [edgePath, edge]]) {
  assert.ok(source.includes("readReadinessPages"), `${file}: admin driver readiness must paginate beyond the first page`);
  assert.ok(source.includes("const maximumRows = 10000"), `${file}: admin driver readiness must enforce a bounded maximum`);
  assert.ok(source.includes("ADMIN_READINESS_OVERFLOW_CHECK_FAILED"), `${file}: admin readiness must detect rows beyond its bounded maximum`);
}


const driverQueueStart = '    if (url.pathname === "/api/v1/admin/driver-documents" && request.method === "GET") {';
const driverQueueEnd = "    const signedDocumentMatch = url.pathname.match";
const restaurantQueueStart = '    if(url.pathname==="/api/v1/admin/restaurants"&&request.method==="GET"){';
const restaurantQueueEnd = "    const restaurantReviewMatch=";
function routeSection(source, startMarker, endMarker, file) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `${file}: admin review queue route is missing or malformed`);
  return source.slice(start, end);
}
const availabilityRouteStart = '    if (url.pathname === "/api/v1/driver/availability" && request.method === "PATCH") {';
const availabilityRouteEnd = '    if (url.pathname === "/api/v1/driver/location" && request.method === "POST") {';
assert.equal(routeSection(api, availabilityRouteStart, availabilityRouteEnd, apiPath), routeSection(edge, availabilityRouteStart, availabilityRouteEnd, edgePath), "API and deployed Edge Function driver availability readiness checks must remain identical");
for (const [file, source] of [[apiPath, api], [edgePath, edge]]) {
  assert.ok(source.includes("ADMIN_DRIVER_QUEUE_PAGE_FAILED"), `${file}: driver review queue must use bounded keyset pages`);
  assert.ok(source.includes("INVALID_QUEUE_CURSOR"), `${file}: driver review queue must validate untrusted cursors`);
  assert.ok(source.includes("ADMIN_RESTAURANTS_CURSOR_INVALID"), `${file}: restaurant review queue must validate generated cursors`);
  assert.ok(source.includes("queue_meta"), `${file}: driver review queue must return per-group pagination metadata`);
}
assert.equal(routeSection(api, driverQueueStart, driverQueueEnd, apiPath), routeSection(edge, driverQueueStart, driverQueueEnd, edgePath), "API and deployed Edge Function driver review queue routes must remain identical");
assert.equal(routeSection(api, restaurantQueueStart, restaurantQueueEnd, apiPath), routeSection(edge, restaurantQueueStart, restaurantQueueEnd, edgePath), "API and deployed Edge Function restaurant review queue routes must remain identical");
assert.ok(adminJs.includes("loadDriverQueuePage") && adminJs.includes("loadRestaurantQueuePage"), "admin portal must expose next/previous controls for every review queue");
assert.ok(adminJs.includes("queue_type:kind") && adminJs.includes("cursor_created_at"), "driver queue UI must request isolated cursor pages");
console.log("Admin driver/restaurant verification queue API, Edge Function and portal parity checks passed.");

const reviewQueueIndexMigration = readFileSync("supabase/migrations/20261119091250_sjelle_admin_review_queue_keyset_indexes.sql", "utf8");
for (const [indexName, tableName, columns, predicate] of [
  ["sjelle_driver_documents_pending_queue_idx", "sjelle_driver_documents", "created_at asc, id asc", "review_status = 'pending'"],
  ["sjelle_vehicles_pending_queue_idx", "sjelle_vehicles", "created_at asc, id asc", "review_status = 'pending'"],
  ["sjelle_driver_profiles_pending_queue_idx", "sjelle_driver_profiles", "created_at asc, user_id asc", "review_status = 'pending'"],
  ["sjelle_restaurants_pending_queue_idx", "sjelle_restaurants", "created_at asc, id asc", "approval_status = 'pending'"],
]) {
  assert.ok(reviewQueueIndexMigration.includes(`create index if not exists ${indexName}`), `migration must create ${indexName}`);
  assert.ok(reviewQueueIndexMigration.includes(`on public.${tableName} (${columns})`), `migration must index the stable keyset order for ${tableName}`);
  assert.ok(reviewQueueIndexMigration.includes(`where ${predicate}`), `migration must keep ${indexName} limited to pending rows`);
}
console.log("Admin verification queue index migration assertions passed.");


const assignmentGpsReadinessMigration = readFileSync("supabase/migrations/20261120090425_sjelle_assignment_gps_readiness_consistency.sql", "utf8");
assert.ok(assignmentGpsReadinessMigration.includes("create or replace function public.sjelle_guard_driver_assignment()"), "assignment GPS migration must replace the final ride/delivery eligibility guard");
assert.ok(assignmentGpsReadinessMigration.includes("and l.recorded_at >= now() - interval '2 minutes'"), "assignment must reject stale driver GPS fixes");
assert.ok(assignmentGpsReadinessMigration.includes("and l.recorded_at <= now() + interval '15 seconds'"), "assignment must reject future-dated driver GPS fixes");
assert.ok(assignmentGpsReadinessMigration.includes("and l.latitude between 41.7 and 43.4") && assignmentGpsReadinessMigration.includes("and l.longitude between 19.7 and 22.0"), "assignment must reject GPS coordinates outside Kosovo bounds");
assert.ok(assignmentGpsReadinessMigration.includes("and l.accuracy_m between 0 and 1500"), "assignment must enforce the same non-negative GPS accuracy limit as online readiness");
assert.ok(assignmentGpsReadinessMigration.includes("DRIVER_HAS_ACTIVE_JOB"), "assignment GPS hardening must preserve cross-service exclusive driver assignment");
assert.ok(assignmentGpsReadinessMigration.includes("revoke all on function public.sjelle_guard_driver_assignment() from public, anon, authenticated") && assignmentGpsReadinessMigration.includes("grant execute on function public.sjelle_guard_driver_assignment() to service_role"), "assignment guard must remain service-role only");
console.log("Driver assignment GPS readiness consistency assertions passed.");
