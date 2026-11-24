import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = (process.argv[2] || "https://fadiu007-creator.github.io/Sjelle/").replace(/\/?$/, "/");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
const pageErrors = [];
const missingAssets = [];

page.on("pageerror", error => pageErrors.push(error.message));
page.on("response", response => {
  if (response.url().startsWith(baseUrl) && response.status() >= 400) {
    missingAssets.push(`${response.status()} ${response.url()}`);
  }
});

try {
  const portals = [
    { path: "", title: "Sjelle", label: "homepage" },
    { path: "driver/", title: "Shoferi", label: "driver portal" },
    { path: "merchant/", title: "Restoranti", label: "merchant portal" },
    { path: "admin/", title: "Administrimi", label: "admin portal" },
  ];

  for (const portal of portals) {
    const url = new URL(portal.path, baseUrl).toString();
    let response;
    let lastError;
    // GitHub Pages deployments can take a short time to propagate after deploy-pages completes.
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        if (response && response.status() === 200) break;
        lastError = new Error(`HTTP ${response?.status() ?? "no response"} at ${url}`);
      } catch (error) {
        lastError = error;
      }
      if (attempt < 4) await page.waitForTimeout(2500);
    }
    assert.ok(response && response.status() === 200, `${portal.label} should load successfully: ${lastError?.message || "unexpected response"}`);
    await page.locator("body").waitFor();
    await page.waitForTimeout(800);
    assert.match(await page.title(), new RegExp(portal.title, "i"), `${portal.label} title`);
    console.log(`PASS ${portal.label}: ${url}`);
  }

  const adminUrl = new URL("admin/", baseUrl).toString();
  await page.goto(adminUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  const adminLoginLink = page.locator("#admin-login-link");
  await adminLoginLink.waitFor({ state: "visible" });
  const adminLoginTarget = new URL(await adminLoginLink.getAttribute("href"), adminUrl);
  assert.equal(adminLoginTarget.searchParams.get("return_to"), "admin", "admin login link must preserve the admin return destination");
  assert.match(await page.locator("#admin-alert").textContent(), /Kyçu me llogarinë e administratorit/i, "unauthenticated admin portal must explain how to sign in");
  assert.equal(await page.locator("#pricing-form input").first().isDisabled(), true, "admin controls must stay locked without an authenticated admin session");
  const quickLinks = ["#driver-applications", "#restaurant-applications", "#city-operations", "#cash-reconciliation"];
  for (const target of quickLinks) {
    const link = page.locator(`.admin-quick-nav a[href="${target}"]`);
    await link.waitFor({ state: "visible" });
    assert.equal(await page.locator(target).count(), 1, `admin shortcut ${target} must have one destination`);
  }
  await page.locator('.admin-quick-nav a[href="#driver-applications"]').click();
  assert.equal(new URL(page.url()).hash, "#driver-applications", "driver applications shortcut must navigate to the queue");

  const apiOrigin = "https://saavqlbwffrwxingbnri.supabase.co/functions/v1/sjelle-api/api/v1";
  const adminRequests = [];
  let adminRoleAllowed = true;
  let adminDocumentPending = false;
  let adminReadiness = [];
  let adminSignedUrlResponseSent = false;
  let adminCashBalances = [];
  const cashHandoverRequests = [];
  await page.route(`${apiOrigin}/**`, async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname.replace("/functions/v1/sjelle-api/api/v1", "");
    if (pathname === "/auth/login") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { access_token: "sjelle-admin-smoke-token", refresh_token: "sjelle-admin-smoke-refresh", expires_in: 3600, user: { id: "smoke-admin", email: "admin-smoke@example.test" } } }) });
    }
    if (!request.headers().authorization?.includes("sjelle-admin-smoke-token")) {
      return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "UNAUTHENTICATED" } }) });
    }
    if (pathname.startsWith("/admin/") && !adminRoleAllowed) {
      return route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "FORBIDDEN" } }) });
    }
    adminRequests.push(pathname);
    if (pathname === "/admin/cash-handovers" && request.method() === "POST") {
      const requestBody = request.postDataJSON();
      cashHandoverRequests.push({
        body: requestBody,
        idempotencyKey: request.headers()["idempotency-key"] || "",
      });
      adminCashBalances = [];
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
        id: "55555555-5555-4555-8555-555555555555",
        driver_id: requestBody.driver_id,
        amount_cents: requestBody.amount_cents,
        currency: "EUR",
        balance_before_cents: 2750,
        balance_after_cents: 2750 - requestBody.amount_cents,
        reference: requestBody.reference || null,
        replayed: false,
      } }) });
    }
    if (pathname.startsWith("/admin/driver-documents/") && pathname.endsWith("/signed-url")) {
      await new Promise(resolve => setTimeout(resolve, 250));
      adminSignedUrlResponseSent = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { url: `${new URL(apiOrigin).origin}/storage/v1/object/sign/sjelle-driver-documents/smoke.pdf?token=smoke` } }) });
    }
    const payloads = {
      "/admin/cities": { data: [] },
      "/admin/driver-documents": { data: { documents: adminDocumentPending ? [{ id: "33333333-3333-4333-8333-333333333333", document_type: "identity", driver_id: "smoke-driver", document_number_last4: "1234", expires_at: "2027-12-31" }] : [], vehicles: [], drivers: [], queue_meta: { documents: { limit: 100, returned: adminDocumentPending ? 1 : 0, has_more: false, next_cursor: null }, vehicles: { limit: 100, returned: 0, has_more: false, next_cursor: null }, drivers: { limit: 100, returned: 0, has_more: false, next_cursor: null } }, readiness: adminReadiness, readiness_meta: { possibly_truncated: false } } },
      "/admin/restaurants": { data: [], meta: { limit: 100, returned: 0, has_more: false, next_cursor: null } },
      "/admin/support-tickets": { data: [] },
      "/admin/cash-balances": { data: adminCashBalances },
    };
    return route.fulfill({ status: payloads[pathname] ? 200 : 404, contentType: "application/json", body: JSON.stringify(payloads[pathname] || { error: { code: "NOT_FOUND" } }) });
  });

  await adminLoginLink.click();
  await page.locator("#account-dialog[open]").waitFor({ state: "visible" });
  await page.locator('#auth-form input[name="email"]').fill("admin-smoke@example.test");
  await page.locator('#auth-form input[name="password"]').fill("x".repeat(12));
  await page.locator("#auth-submit").click();
  await page.waitForURL(url => url.pathname.endsWith("/admin/"), { timeout: 15000 });
  await page.locator('#driver-queue [data-queue-items="documents"]').getByText("Nuk ka hyrje në pritje në këtë grup.").waitFor({ state: "visible", timeout: 15000 });
  await page.getByText("Nuk ka profile shoferësh për t’u shfaqur.").waitFor({ state: "visible", timeout: 15000 });
  await page.getByText("Nuk ka aplikime restorantesh në këtë faqe.").waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await page.locator("#driver-queue-count").textContent(), "0", "admin dashboard must show zero pending driver review items when queue is empty");
  assert.equal(await page.locator("#restaurant-queue-count").textContent(), "0", "admin dashboard must show zero pending restaurant applications when queue is empty");
  assert.ok(adminRequests.includes("/admin/driver-documents"), "admin login must load the protected driver application queue");
  assert.ok(adminRequests.includes("/admin/restaurants"), "admin login must load the protected restaurant application queue");
  assert.ok(adminRequests.includes("/admin/cash-balances"), "admin login must load protected driver cash balances");
  assert.match(await page.locator("#admin-alert").textContent(), /Paneli administrativ u ngarkua/i, "admin dashboard should report a successful protected load");
  console.log("PASS admin login returns to the admin dashboard and loads protected driver/restaurant queues with the session token");

  adminDocumentPending = true;
  await page.locator("#queue-refresh").click();
  await page.getByText("Dokument · identity").waitFor({ state: "visible" });
  const storageOrigin = new URL(apiOrigin).origin;
  await page.route(`${storageOrigin}/storage/v1/object/sign/**`, route => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Document preview smoke</title><p>Document preview</p>" }));
  adminSignedUrlResponseSent = false;
  const documentPopupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Shiko dokumentin" }).click();
  const documentPopup = await documentPopupPromise;
  assert.equal(adminSignedUrlResponseSent, false, "document preview tab must open synchronously before the signed-URL request resolves");
  await documentPopup.waitForURL(url => url.toString().startsWith(`${storageOrigin}/storage/v1/object/sign/`), { timeout: 10000 });
  assert.equal(adminSignedUrlResponseSent, true, "the signed document URL should be loaded after the preview tab is opened");
  assert.equal(await documentPopup.evaluate(() => window.opener), null, "document preview must not retain an opener reference");
  await documentPopup.close();
  await page.unroute(`${storageOrigin}/storage/v1/object/sign/**`);
  adminDocumentPending = false;
  await page.locator("#queue-refresh").click();
  await page.locator('#driver-queue [data-queue-items="documents"]').getByText("Nuk ka hyrje në pritje në këtë grup.").waitFor({ state: "visible" });
  console.log("PASS admin document review opens the private signed document in a new tab before the asynchronous request and clears opener access");

  adminCashBalances = [{
    driver_id: "44444444-4444-4444-8444-444444444444",
    review_status: "approved",
    city_id: null,
    online: false,
    balance_cents: "2750",
    last_collection_at: "2026-11-24T08:00:00.000Z",
  }];
  await page.locator("#cash-balances-refresh").click();
  await page.locator("#cash-balances").getByText(/Cash i padorëzuar: 27\.50/).waitFor({ state: "visible" });
  const cashHandoverForm = page.locator("#cash-balances form").first();
  await cashHandoverForm.locator('input[name="amount"]').fill("12.50");
  await cashHandoverForm.locator('input[name="reference"]').fill("receipt-smoke-1");
  page.once("dialog", dialog => dialog.accept());
  await cashHandoverForm.getByRole("button", { name: "Regjistro dorëzimin" }).click();
  await page.getByText(/Dorëzimi u regjistrua/).waitFor({ state: "visible" });
  assert.equal(cashHandoverRequests.length, 1, "admin cash handover should submit exactly once");
  assert.equal(cashHandoverRequests[0].body.driver_id, "44444444-4444-4444-8444-444444444444");
  assert.equal(cashHandoverRequests[0].body.amount_cents, 1250, "admin cash handover must submit whole euro cents");
  assert.equal(cashHandoverRequests[0].body.reference, "receipt-smoke-1");
  assert.match(cashHandoverRequests[0].idempotencyKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, "admin cash handover must use a secure UUID idempotency key");
  assert.equal(await page.locator("#cash-balances").getByText("Nuk ka cash të padorëzuar nga shoferët në librin financiar.").count(), 1, "successful handover must refresh the remaining driver balance");
  console.log("PASS admin cash handover confirms physical receipt, submits cents with a secure idempotency key, and refreshes the driver balance");
  adminReadiness = [
    {
      user_id: "smoke-rejected-driver", city_id: "smoke-city", selected_mode: "ride",
      review_status: "rejected", online: false, evidence_ready: false,
      documents: [
        { document_type: "identity", status: "rejected", expires_at: null, rejection_reason: "Foto e paqartë" },
        { document_type: "driving_licence", status: "missing", expires_at: null, rejection_reason: null },
        { document_type: "vehicle_registration", status: "missing", expires_at: null, rejection_reason: null },
        { document_type: "insurance", status: "missing", expires_at: null, rejection_reason: null }
      ],
      vehicles: [{ vehicle_type: "standard", make: "Test", model: "Vehicle", color: null, status: "expired", document_expires_at: "2026-01-01" }]
    },
    {
      user_id: "smoke-approved-driver", city_id: "smoke-city", selected_mode: "ride",
      review_status: "approved", online: false, evidence_ready: false,
      documents: [
        { document_type: "identity", status: "missing", expires_at: null, rejection_reason: null },
        { document_type: "driving_licence", status: "missing", expires_at: null, rejection_reason: null },
        { document_type: "vehicle_registration", status: "missing", expires_at: null, rejection_reason: null },
        { document_type: "insurance", status: "missing", expires_at: null, rejection_reason: null }
      ],
      vehicles: []
    }
  ];
  await page.locator("#queue-refresh").click();
  await page.locator("#driver-readiness").getByText("smoke-rejected-driver", { exact: false }).waitFor({ state: "visible", timeout: 15000 });
  const readinessText = await page.locator("#driver-readiness").textContent();
  assert.match(readinessText, /smoke-rejected-driver/, "admin readiness must include rejected driver profiles");
  assert.match(readinessText, /Aplikimi: Refuzuar/, "admin readiness must show rejected profile status");
  assert.match(readinessText, /Identiteti: Refuzuar/, "admin readiness must show the latest rejected document");
  assert.match(readinessText, /Foto e paqartë/, "admin readiness must show the recorded rejection reason");
  assert.match(readinessText, /smoke-approved-driver/, "admin readiness must include already-approved driver profiles");
  assert.match(readinessText, /Aplikimi: Aprovuar/, "admin readiness must distinguish approved profiles");
  assert.match(readinessText, /Evidenca: e paplotë/, "an approved profile with missing evidence must not be presented as evidence-ready");
  console.log("PASS admin readiness lists all driver profile states and distinguishes rejected, missing and incomplete evidence");


  adminRoleAllowed = false;
  await page.locator("#queue-refresh").click();
  await page.locator("#restaurants-refresh").click();
  const forbiddenMessage = /Llogaria është kyçur, por nuk ka rolin admin në sjelle_user_roles/i;
  await page.locator("#driver-queue").getByText(forbiddenMessage).waitFor({ state: "visible" });
  await page.locator("#admin-restaurants").getByText(forbiddenMessage).waitFor({ state: "visible" });
  assert.equal(await page.locator("#driver-queue-count").textContent(), "—", "failed driver queue requests must not be displayed as an empty queue");
  assert.equal(await page.locator("#restaurant-queue-count").textContent(), "—", "failed restaurant queue requests must not be displayed as an empty queue");
  for (const selector of ["#driver-queue", "#admin-restaurants"]) {
    const setupLink = page.locator(selector).locator("a[href$=\"first-admin.sql\"]");
    await setupLink.waitFor({ state: "visible" });
    assert.equal(await setupLink.getAttribute("target"), "_blank");
    assert.equal(await setupLink.getAttribute("rel"), "noopener noreferrer");
  }
  adminRoleAllowed = true;
  await page.locator("#queue-refresh").click();
  await page.locator("#restaurants-refresh").click();
  await page.locator('#driver-queue [data-queue-items="documents"]').getByText("Nuk ka hyrje në pritje në këtë grup.").waitFor({ state: "visible" });
  await page.getByText("Nuk ka aplikime restorantesh në këtë faqe.").waitFor({ state: "visible" });
  console.log("PASS a signed-in non-admin receives a clear role error and safe first-admin setup link in both queues");
  await page.unroute(`${apiOrigin}/**`);

  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  const appSourceResponse = await page.request.get(new URL("app.js", baseUrl).toString());
  assert.equal(appSourceResponse.status(), 200, "customer application bundle should load");
  const appSource = await appSourceResponse.text();
  assert.match(appSource, /Nuk u gjet shofer brenda 15 minutave/, "dispatch timeout must be explained to customers");
  assert.match(appSource, /nuk u mblodh pagesë/, "failed or cancelled cash rides must clearly state that no payment was collected");
  assert.match(appSource, /dataset\.rideStatus/, "customer ride cards must expose their last rendered status for change detection");
  assert.match(appSource, /refreshMyRidesIfChanged/, "customer ride status must refresh without rebuilding unchanged live tracking maps");
  const driverSourceResponse = await page.request.get(new URL("driver/driver.js", baseUrl).toString());
  assert.equal(driverSourceResponse.status(), 200, "driver application bundle should load");
  const driverSource = await driverSourceResponse.text();
  assert.match(driverSource, /cancelled_by_driver/, "driver portal must expose the safe ride-cancellation transition");
  assert.match(driverSource, /Anulo udhëtimin/, "driver portal must provide an explicit cancellation action");
  assert.match(driverSource, /async function changeDriverMode\(\)/, "driver portal must handle an explicit mode change");
  assert.ok(driverSource.includes('$("#driver-mode").addEventListener("change",changeDriverMode)'), "driver mode selector must apply changes immediately while online");
  assert.ok(driverSource.includes('JSON.stringify({online:true,mode:next,...location})'), "online mode changes must send a fresh GPS fix through the server-authoritative availability endpoint");
  assert.ok(driverSource.includes('JSON.stringify({online,mode,...location})'), "going online must persist GPS and availability together instead of writing location separately");
  assert.ok(driverSource.includes('async function currentDriverLocation()'), "driver portal must validate GPS before requesting an online transition");
  assert.ok(driverSource.includes('DRIVER_HAS_ACTIVE_JOB'), "driver mode changes must explain when an active job blocks switching");
  const driverHtmlResponse = await page.request.get(new URL("driver/", baseUrl).toString());
  assert.equal(driverHtmlResponse.status(), 200, "driver portal markup should load");
  const driverHtml = await driverHtmlResponse.text();
  assert.match(driverHtml, /ndërrimi i modalitetit zbatohet menjëherë/, "driver portal must explain online mode switching");
  assert.ok(driverHtml.includes('id="document-requirements"'), "driver portal must show the four-document readiness checklist");
  assert.ok(driverHtml.includes("driver-document-readiness-20261117"), "driver portal must refresh cached readiness assets");
  assert.ok(driverSource.includes('const required=[["identity","Dokument identiteti"]'), "driver portal must enumerate all four required document types");
  assert.ok(driverSource.includes('status="missing"') && driverSource.includes('status=expired?"expired"'), "driver portal must distinguish missing and expired documents");
  assert.ok(driverSource.includes('const aId=String(a.id||"")'), "driver portal must deterministically choose the latest document when timestamps tie");
  await page.waitForFunction(
    () => document.querySelectorAll("#city-select option").length >= 2,
    { timeout: 15000 },
  );
  const cityOptions = await page.locator("#city-select option").count();
  assert.equal(cityOptions, 6, "homepage should render all six configured Kosovo launch cities from the live API");
  console.log(`PASS city selector rendered all ${cityOptions} configured launch cities`);

  const signupLink = page.locator('.hero-actions a[href*="account=signup"]');
  await signupLink.waitFor({ state: "visible" });
  await signupLink.click();
  await page.locator("#account-dialog[open]").waitFor({ state: "visible" });
  assert.equal((await page.locator("#auth-submit").textContent()).trim(), "Regjistrohu", "signup deep link should open signup mode using Kosovo Albanian copy");
  await page.locator("#account-close").click();
  console.log("PASS homepage signup CTA opens the real signup dialog");

  const rideApi = {
    quoteRequests: 0,
    quoteBodies: [],
    geocodeQueries: [],
    latestQuoteId: "",
    bookingKeys: [],
    ride: {
      id: "55555555-5555-4555-8555-555555555555",
      status: "searching",
      pickup_label: "Rruga A, Ferizaj",
      pickup_lat: 42.3702,
      pickup_lon: 21.1553,
      destination_label: "Sheshi, Ferizaj",
      destination_lat: 42.3712,
      destination_lon: 21.1563,
      quoted_amount_cents: 450,
      final_amount_cents: null,
      payment_method: "cash",
      created_at: "2026-11-11T09:00:00Z",
    },
  };
  await page.route(`${apiOrigin}/auth/login`, route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data: { access_token: "sjelle-ride-smoke-token", refresh_token: "sjelle-ride-smoke-refresh", expires_in: 3600, user: { id: "ride-smoke-user", email: "ride-smoke@example.test" } } }),
  }));
  await page.route(`${apiOrigin}/auth/refresh`, route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data: { access_token: "sjelle-ride-smoke-token-refreshed", refresh_token: "sjelle-ride-smoke-refresh", expires_in: 3600, user: { id: "ride-smoke-user", email: "ride-smoke@example.test" } } }),
  }));
  await page.route(`${apiOrigin}/geocode`, async route => {
    const requestBody = JSON.parse(route.request().postData() || "{}");
    const query = String(requestBody.query || "").toLowerCase();
    rideApi.geocodeQueries.push(requestBody.query || "");
    const pickup = query.includes("nisja");
    const updatedPickup = pickup && query.includes("e re");
    const thirdPickup = pickup && query.includes("tjetër");
    const oldPickup = pickup && query.includes("e vjeter");
    if (oldPickup) await new Promise(resolve => setTimeout(resolve, 350));
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [{
        label: pickup ? (thirdPickup ? "Rruga tjetër, Ferizaj" : oldPickup ? "Rruga e Vjetër, Ferizaj" : updatedPickup ? "Rruga e Re, Ferizaj" : "Rruga A, Ferizaj") : "Sheshi, Ferizaj",
        lat: pickup ? (thirdPickup ? 42.3733 : oldPickup ? 42.3744 : updatedPickup ? 42.3722 : 42.3702) : 42.3712,
        lon: pickup ? 21.1553 : 21.1563,
      }] }),
    });
  });
  let secondQuoteStartedResolve;
  const secondQuoteStarted = new Promise(resolve => { secondQuoteStartedResolve = resolve; });
  await page.route(`${apiOrigin}/ride-quotes`, async route => {
    rideApi.quoteRequests += 1;
    const quoteNumber = rideApi.quoteRequests;
    const requestBody = JSON.parse(route.request().postData() || "{}");
    rideApi.quoteBodies.push(requestBody);
    assert.equal(requestBody.city, "ferizaj", "ride quote must use the selected city");
    assert.equal(requestBody.vehicle_type, "standard", "ride quote must send the selected vehicle type");
    const quoteId = ["44444444-4444-4444-8444-444444444444", "66666666-6666-4666-8666-666666666666", "77777777-7777-4777-8777-777777777777", "88888888-8888-4888-8888-888888888888", "99999999-9999-4999-8999-999999999999", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"][quoteNumber - 1];
    rideApi.latestQuoteId = quoteId;
    if (quoteNumber === 2) {
      secondQuoteStartedResolve();
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ data: {
        quote_id: quoteId,
        city: "ferizaj",
        vehicle_type: "standard",
        pickup_label: requestBody.pickup_label,
        pickup_lat: requestBody.pickup_lat,
        pickup_lon: requestBody.pickup_lon,
        destination_label: requestBody.destination_label,
        destination_lat: requestBody.destination_lat,
        destination_lon: requestBody.destination_lon,
        pricing_kind: "estimated",
        pricing_version: "smoke-v1",
        amount_cents: 450,
        currency: "EUR",
        distance_m: 2500,
        duration_s: 420,
        ...(quoteNumber === 5 ? {} : { expires_at: new Date(Date.now() + (quoteNumber === 1 ? 2500 : 5 * 60 * 1000)).toISOString() }),
      } }),
    });
  });
  await page.route(`${apiOrigin}/rides`, async route => {
    const request = route.request();
    if (request.method() === "GET") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [rideApi.ride] }) });
    }
    if (request.method() === "POST") {
      const key = request.headers()["idempotency-key"];
      assert.ok(key && key.length >= 12, "ride booking must send an idempotency key");
      rideApi.bookingKeys.push(key);
      const body = JSON.parse(request.postData() || "{}");
      assert.equal(body.quote_id, rideApi.latestQuoteId, "booking must use the latest non-stale quote");
      if (rideApi.bookingKeys.length === 1) {
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "RIDE_BOOKING_FAILED", message: "Përgjigjja u ndërpre përkohësisht." } }),
        });
      }
      if (rideApi.bookingKeys.length === 3) {
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: { code: "ACTIVE_RIDE_EXISTS" } }),
        });
      }
      const latestQuote = rideApi.quoteBodies.at(-1);
      rideApi.ride = {
        ...rideApi.ride,
        pickup_label: latestQuote.pickup_label,
        pickup_lat: latestQuote.pickup_lat,
        pickup_lon: latestQuote.pickup_lon,
        destination_label: latestQuote.destination_label,
        destination_lat: latestQuote.destination_lat,
        destination_lon: latestQuote.destination_lon,
      };
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ data: { ...rideApi.ride, driver_offer_sent: true } }),
      });
    }
    return route.continue();
  });

  // The earlier admin smoke login shares this tab's sessionStorage; start the customer flow as a clean user.
  await page.evaluate(() => sessionStorage.removeItem("sjelle.session"));
  await page.goto(new URL("?account=login", baseUrl).toString(), { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.locator("#account-dialog[open]").waitFor({ state: "visible" });
  await page.locator('#auth-form input[name="email"]').fill("ride-smoke@example.test");
  await page.locator('#auth-form input[name="password"]').fill("x".repeat(12));
  await page.locator("#auth-submit").click();
  await page.locator("#account-dialog[open]").waitFor({ state: "hidden" });
  await page.waitForFunction(() => [...document.querySelectorAll("#city-select option")].some(option => option.value === "ferizaj"), { timeout: 15000 });
  await page.locator("#city-select").selectOption("ferizaj");

  await page.locator('#ride-quote-form input[name="pickup_query"]').fill("Nisja, Ferizaj");
  await page.locator("#find-pickup").click();
  await page.locator("#pickup-suggestions button").first().click();
  await page.locator('#ride-quote-form input[name="destination_query"]').fill("Destinacioni, Ferizaj");
  await page.locator("#find-destination").click();
  await page.locator("#destination-suggestions button").first().click();

  // A slower response for an older pickup search must not overwrite the newer result.
  const pickupAddressInput = page.locator('#ride-quote-form input[name="pickup_query"]');
  await pickupAddressInput.fill("Nisja e vjeter, Ferizaj");
  await page.locator("#find-pickup").click();
  await pickupAddressInput.fill("Nisja e re, Ferizaj");
  await page.locator("#find-pickup").click();
  await page.locator("#pickup-suggestions button").first().waitFor({ state: "visible" });
  assert.equal(await page.locator("#pickup-suggestions button").first().textContent(), "Rruga e Re, Ferizaj");
  await page.waitForTimeout(450);
  assert.equal(await page.locator("#pickup-suggestions button").first().textContent(), "Rruga e Re, Ferizaj", "a late older geocode response must not overwrite the latest pickup suggestions");
  await page.locator("#pickup-suggestions button").first().click();

  for (const name of ["pickup_lon", "destination_lon"]) {
    const field = page.locator(`#ride-quote-form input[name="${name}"]`);
    const originalValue = await field.inputValue();
    await field.evaluate(element => { element.value = ""; });
    await page.locator('#ride-quote-form button[type="submit"]').click();
    await page.locator("#ride-quote-message").waitFor({ state: "visible" });
    assert.match(await page.locator("#ride-quote-message").textContent(), /Zgjedh një adresë të sugjeruar/i, `${name} must be validated before requesting a quote`);
    assert.equal(rideApi.quoteRequests, 0, "invalid coordinates must not reach the quote API");
    await field.evaluate((element, value) => { element.value = value; }, originalValue);
  }

  const pickupQuery = page.locator('#ride-quote-form input[name="pickup_query"]');
  const quoteSubmit = page.locator('#ride-quote-form button[type="submit"]');
  const quoteConfirm = page.locator("#ride-quote-result").getByRole("button", { name: "Konfirmo rezervimin" });

  // Editing an address after a quote must remove the old confirmation immediately.
  await quoteSubmit.click();
  await quoteConfirm.waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const button = document.querySelector("#ride-quote-result button");
    return Boolean(button?.disabled && button.textContent?.includes("Çmimi skadoi"));
  }, null, { timeout: 6000 });
  assert.match(await page.locator("#ride-quote-result").textContent(), /Çmimi skadoi/i, "expired server quotes must disable booking and ask the customer to recalculate");
  await pickupQuery.fill("Nisja e re, Ferizaj");
  assert.equal(await quoteConfirm.count(), 0, "changing pickup must invalidate the displayed quote and booking action");
  assert.equal(await page.locator('#ride-quote-form input[name="pickup_lat"]').inputValue(), "", "changing pickup must clear its previously selected coordinates");
  await page.locator("#find-pickup").click();
  await page.locator("#pickup-suggestions button").first().click();

  // A response for an older in-flight request must not restore a stale quote.
  await quoteSubmit.click();
  await secondQuoteStarted;
  await pickupQuery.fill("Nisja tjetër, Ferizaj");
  await page.waitForTimeout(400);
  assert.equal(await quoteConfirm.count(), 0, "a quote response for coordinates changed while the request was in flight must be ignored");
  assert.match(await page.locator("#ride-quote-message").textContent(), /ndryshuan gjatë llogaritjes/i);
  await page.locator("#find-pickup").click();
  await page.waitForFunction(() => document.querySelectorAll("#pickup-suggestions button").length > 0 || Boolean(document.querySelector("#pickup-suggestions")?.textContent?.trim()), null, { timeout: 10000 }).catch(async error => {
    throw new Error("Pickup geocoding produced no visible result: " + JSON.stringify({ geocodeQueries: rideApi.geocodeQueries, message: await page.locator("#ride-quote-message").textContent(), suggestions: await page.locator("#pickup-suggestions").textContent(), pickupQuery: await pickupQuery.inputValue(), selectedCity: await page.locator("#city-select").inputValue(), findPickupDisabled: await page.locator("#find-pickup").isDisabled(), findPickupVisible: await page.locator("#find-pickup").isVisible(), quoteSubmitDisabled: await quoteSubmit.isDisabled(), accountDialogVisible: await page.locator("#account-dialog").isVisible(), pageUrl: page.url() }) + "; " + error.message);
  });
  await page.locator("#pickup-suggestions button").first().click();

  await quoteSubmit.click();
  await quoteConfirm.waitFor({ state: "visible" });
  assert.equal(rideApi.quoteBodies[2].pickup_label, "Rruga tjetër, Ferizaj", "new quote must use the newly selected pickup");
  assert.equal(rideApi.quoteBodies[2].destination_label, "Sheshi, Ferizaj", "unchanged destination must remain selected");

  // Changing the vehicle class also invalidates the price shown for the old class.
  const vehicleType = page.locator('#ride-quote-form select[name="vehicle_type"]');
  await vehicleType.selectOption("comfort");
  assert.equal(await quoteConfirm.count(), 0, "changing vehicle type must invalidate the displayed quote");
  await vehicleType.selectOption("standard");
  await quoteSubmit.click();
  await quoteConfirm.waitFor({ state: "visible", timeout: 10000 }).catch(async error => {
    const details = { quoteRequests: rideApi.quoteRequests, quoteBodies: rideApi.quoteBodies, message: await page.locator("#ride-quote-message").textContent(), pickupLabel: await page.locator('#ride-quote-form input[name="pickup_label"]').inputValue(), pickupLat: await page.locator('#ride-quote-form input[name="pickup_lat"]').inputValue(), pickupLon: await page.locator('#ride-quote-form input[name="pickup_lon"]').inputValue(), destinationLabel: await page.locator('#ride-quote-form input[name="destination_label"]').inputValue(), destinationLat: await page.locator('#ride-quote-form input[name="destination_lat"]').inputValue(), destinationLon: await page.locator('#ride-quote-form input[name="destination_lon"]').inputValue(), vehicleType: await vehicleType.inputValue() };
    throw new Error("Fourth ride quote did not render confirmation: " + JSON.stringify(details) + "; " + error.message);
  });
  assert.equal(rideApi.quoteRequests, 4, "a fresh quote is required after pickup, destination and vehicle changes");
  assert.equal(rideApi.quoteBodies[3].pickup_label, "Rruga tjetër, Ferizaj");
  assert.equal(rideApi.quoteBodies[3].destination_label, "Sheshi, Ferizaj");

  await quoteConfirm.click();
  await page.getByRole("button", { name: "Provo përsëri" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Provo përsëri" }).click();
  await page.locator("#ride-quote-result").getByText("Kërkesa për udhëtim u regjistrua").waitFor({ state: "visible" });
  await pickupQuery.fill("Adresa për udhëtimin tjetër, Ferizaj");
  await page.locator("#ride-quote-result").getByText("Kërkesa për udhëtim u regjistrua").waitFor({ state: "visible" });
  assert.equal(rideApi.bookingKeys.length, 2, "booking retry should issue exactly two requests");
  assert.equal(rideApi.bookingKeys[0], rideApi.bookingKeys[1], "booking retry must reuse the same idempotency key");
  await page.getByRole("button", { name: "Shiko udhëtimet e mia" }).click();
  await page.locator("#account-dialog[open]").waitFor({ state: "visible" });
  await page.locator("#my-rides").getByText("Po kërkohet shofer").waitFor({ state: "visible" });
  assert.match(await page.locator("#my-rides").textContent(), /Rruga tjetër, Ferizaj → Sheshi, Ferizaj/);
  await page.locator("#account-close").click();

  // A malformed server quote must never receive an invented client-side expiry window.
  await pickupQuery.fill("Nisja me çmim pa afat, Ferizaj");
  await page.locator("#find-pickup").click();
  await page.locator("#pickup-suggestions button").first().click();
  await quoteSubmit.click();
  await page.waitForFunction(() => document.querySelector("#ride-quote-message")?.textContent?.includes("Serveri nuk ktheu një afat të vlefshëm"));
  assert.equal(await quoteConfirm.count(), 0, "a quote without a valid server expiry must not expose a booking action");
  assert.equal(rideApi.quoteRequests, 5, "the missing-expiry scenario must be exercised against the mocked quote API");

  // A second booking with a different quote/key is rejected while the first ride is active.
  await pickupQuery.fill("Nisja me udhëtim aktiv, Ferizaj");
  await page.locator("#find-pickup").click();
  await page.locator("#pickup-suggestions button").first().click();
  await quoteSubmit.click();
  await quoteConfirm.waitFor({ state: "visible" });
  assert.equal(rideApi.quoteRequests, 6, "active-ride conflict scenario must use a fresh quote");
  await quoteConfirm.click();
  await page.getByRole("button", { name: "Provo përsëri pas udhëtimit aktiv" }).waitFor({ state: "visible" });
  assert.match(await page.locator("#ride-quote-message").textContent(), /Ke tashmë një udhëtim aktiv/i);
  await page.getByRole("button", { name: "Shiko udhëtimin aktiv" }).click();
  await page.locator("#account-dialog[open]").waitFor({ state: "visible" });
  await page.locator("#my-rides").getByText("Po kërkohet shofer").waitFor({ state: "visible" });
  await page.locator("#account-close").click();
  assert.equal(rideApi.bookingKeys.length, 3, "the active-ride conflict must reach the booking API exactly once");

  await page.locator("#account-open").click();
  console.log("PASS ride flow validates coordinates, ignores out-of-order geocoding, fails closed on missing/expired quote expiry, invalidates changed addresses/vehicles, retries booking idempotently, blocks a second active ride and opens the existing trip");

  rideApi.ride.status = "driver_assigned";
  let locationRequestCount = 0;
  const locationWaiters = new Map();
  const waitForLocationCount = count => locationRequestCount >= count
    ? Promise.resolve()
    : new Promise(resolve => locationWaiters.set(count, resolve));
  await page.route(`${apiOrigin}/rides/${rideApi.ride.id}/driver-location`, async route => {
    locationRequestCount += 1;
    locationWaiters.get(locationRequestCount)?.();
    const timestamp = new Date().toISOString();
    if (locationRequestCount === 1 || locationRequestCount === 3) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: {
        available: true, latitude: 42.371, longitude: 21.155, accuracy_m: 15, recorded_at: timestamp, updated_at: timestamp,
      } }) });
    }
    if (locationRequestCount === 2) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { available: false } }) });
    }
    return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "DRIVER_LOCATION_UNAVAILABLE" } }) });
  });
  await page.evaluate(() => {
    window.__sjelleTrackingMaps = [];
    const layer = (kind, latlng) => ({
      kind, latlng,
      addTo(map) { this.map = map; map.layers.push(this); return this; },
      bindPopup() { return this; },
      setLatLng(value) { this.latlng = value; return this; },
    });
    window.L = {
      map() {
        const map = {
          layers: [], zoom: 13,
          setView(latlng, zoom) { this.center = latlng; if (zoom !== undefined) this.zoom = zoom; return this; },
          getZoom() { return this.zoom; },
          invalidateSize() {},
          removeLayer(target) { this.layers = this.layers.filter(item => item !== target); },
        };
        window.__sjelleTrackingMaps.push(map);
        return map;
      },
      tileLayer() { return { addTo() { return this; } }; },
      marker(latlng) { return layer("marker", latlng); },
      circleMarker(latlng) { return layer("driver", latlng); },
    };
    const original = window.setInterval.bind(window);
    window.__sjelleOriginalSetInterval = original;
    window.__sjelleTrackingCallbacks = [];
    window.setInterval = (callback, delay, ...args) => {
      if (delay === 10000) {
        window.__sjelleTrackingCallbacks.push(callback);
        return 0;
      }
      return original(callback, delay, ...args);
    };
  });
  await page.locator("#my-rides-open").click();
  await waitForLocationCount(1);
  await page.locator("#my-rides").getByText("Shoferi u përditësua").waitFor({ state: "visible" });
  assert.equal(await page.evaluate(() => window.__sjelleTrackingMaps[0].layers.filter(layer => layer.kind === "driver").length), 1, "a fresh authorized driver location should display one live marker");

  await page.evaluate(() => window.__sjelleTrackingCallbacks[0]());
  await waitForLocationCount(2);
  await page.waitForFunction(() => window.__sjelleTrackingMaps[0].layers.filter(layer => layer.kind === "driver").length === 0);
  assert.match(await page.locator("#my-rides").textContent(), /Po presim vendndodhjen e shoferit/i, "a location revoked or gone stale must clear the old marker");

  await page.evaluate(() => window.__sjelleTrackingCallbacks[0]());
  await waitForLocationCount(3);
  await page.waitForFunction(() => window.__sjelleTrackingMaps[0].layers.filter(layer => layer.kind === "driver").length === 1);
  await page.evaluate(() => window.__sjelleTrackingCallbacks[0]());
  await waitForLocationCount(4);
  await page.waitForFunction(() => window.__sjelleTrackingMaps[0].layers.filter(layer => layer.kind === "driver").length === 0);
  assert.match(await page.locator("#my-rides").textContent(), /Vendndodhja live s’është e disponueshme/i, "an API error must also clear the last precise driver location");
  await page.evaluate(() => { window.setInterval = window.__sjelleOriginalSetInterval; });
  await page.unroute(`${apiOrigin}/rides/${rideApi.ride.id}/driver-location`);
  console.log("PASS customer live tracking removes stale/revoked driver pins, rejects delayed responses and clears the marker on API errors");

  await page.unroute(`${apiOrigin}/auth/login`);
  await page.unroute(`${apiOrigin}/auth/refresh`);
  await page.unroute(`${apiOrigin}/geocode`);
  await page.unroute(`${apiOrigin}/ride-quotes`);
  await page.unroute(`${apiOrigin}/rides`);


  // Offline driver mode selection is persisted server-side and rolled back if the
  // authoritative API rejects a stale client state (for example, an active job).
  const driverPage = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  driverPage.on("pageerror", error => pageErrors.push(error.message));
  driverPage.on("response", response => {
    if (response.url().startsWith(baseUrl) && response.status() >= 400) {
      missingAssets.push(`${response.status()} ${response.url()}`);
    }
  });
  await driverPage.addInitScript(() => {
    sessionStorage.setItem("sjelle.session", JSON.stringify({ access_token: "sjelle-driver-smoke-token" }));
  });
  const driverAvailabilityRequests = [];
  let rejectNextDriverModeChange = false;
  await driverPage.route(`${apiOrigin}/**`, async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname.replace("/functions/v1/sjelle-api/api/v1", "");
    const respond = (status, payload) => route.fulfill({
      status, contentType: "application/json", body: JSON.stringify(payload),
    });
    if (pathname === "/cities") {
      return respond(200, { data: [{ slug: "ferizaj", name: "Ferizaj", active: true }] });
    }
    if (pathname === "/driver/me") {
      return respond(200, { data: {
        profile: {
          user_id: "smoke-driver", review_status: "pending", city_id: "smoke-city",
          online: false, selected_mode: "ride",
        },
        vehicles: [], documents: [],
      } });
    }
    if (pathname === "/driver/offers") return respond(200, { data: [] });
    if (pathname === "/driver/jobs") return respond(200, { data: { rides: [], deliveries: [] } });
    if (pathname === "/driver/availability" && request.method() === "PATCH") {
      const body = request.postDataJSON();
      driverAvailabilityRequests.push(body);
      if (rejectNextDriverModeChange) {
        rejectNextDriverModeChange = false;
        return respond(409, { error: {
          code: "DRIVER_HAS_ACTIVE_JOB",
          message: "Finish or cancel the active job before changing mode.",
        } });
      }
      return respond(200, { data: { online: false, selected_mode: body.mode } });
    }
    return respond(404, { error: { code: "NOT_FOUND" } });
  });
  await driverPage.goto(new URL("driver/", baseUrl).toString(), { waitUntil: "domcontentloaded", timeout: 30000 });
  await driverPage.locator("#availability-section").waitFor({ state: "visible", timeout: 15000 });
  await driverPage.locator("#driver-mode").selectOption("delivery");
  await driverPage.waitForFunction(() => document.querySelector("#driver-alert")?.textContent?.includes("u ruajt"));
  assert.deepEqual(driverAvailabilityRequests[0], { online: false, mode: "delivery" });
  assert.equal(await driverPage.locator("#driver-mode").inputValue(), "delivery");
  rejectNextDriverModeChange = true;
  await driverPage.locator("#driver-mode").selectOption("ride");
  await driverPage.waitForFunction(() => document.querySelector("#driver-alert")?.textContent?.includes("Përfundo ose anulo punën aktive"));
  assert.deepEqual(driverAvailabilityRequests[1], { online: false, mode: "ride" });
  assert.equal(await driverPage.locator("#driver-mode").inputValue(), "delivery", "a rejected offline mode change must restore the last server-confirmed mode");
  await driverPage.close();
  console.log("PASS offline driver mode selection persists through the API and restores the server-confirmed value when the API rejects a change");

  assert.deepEqual(missingAssets, [], "Pages must not return 4xx/5xx for local portal files");
  assert.deepEqual(pageErrors, [], "portal pages must not raise uncaught JavaScript errors");
  console.log("PASS no broken local assets and no uncaught browser JavaScript errors");
} finally {
  await browser.close();
}
