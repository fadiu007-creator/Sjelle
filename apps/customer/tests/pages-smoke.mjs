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
    const payloads = {
      "/admin/cities": { data: [] },
      "/admin/driver-documents": { data: { documents: [], vehicles: [], drivers: [] } },
      "/admin/restaurants": { data: [] },
      "/admin/support-tickets": { data: [] },
    };
    return route.fulfill({ status: payloads[pathname] ? 200 : 404, contentType: "application/json", body: JSON.stringify(payloads[pathname] || { error: { code: "NOT_FOUND" } }) });
  });

  await adminLoginLink.click();
  await page.locator("#account-dialog[open]").waitFor({ state: "visible" });
  await page.locator('#auth-form input[name="email"]').fill("admin-smoke@example.test");
  await page.locator('#auth-form input[name="password"]').fill("x".repeat(12));
  await page.locator("#auth-submit").click();
  await page.waitForURL(url => url.pathname.endsWith("/admin/"), { timeout: 15000 });
  await page.getByText("Nuk ka dokumente, automjete ose aplikime në pritje.").waitFor({ state: "visible", timeout: 15000 });
  await page.getByText("Nuk ka aplikime restorantesh në pritje.").waitFor({ state: "visible", timeout: 15000 });
  assert.equal(await page.locator("#driver-queue-count").textContent(), "0", "admin dashboard must show zero pending driver review items when queue is empty");
  assert.equal(await page.locator("#restaurant-queue-count").textContent(), "0", "admin dashboard must show zero pending restaurant applications when queue is empty");
  assert.ok(adminRequests.includes("/admin/driver-documents"), "admin login must load the protected driver application queue");
  assert.ok(adminRequests.includes("/admin/restaurants"), "admin login must load the protected restaurant application queue");
  assert.match(await page.locator("#admin-alert").textContent(), /Paneli administrativ u ngarkua/i, "admin dashboard should report a successful protected load");
  console.log("PASS admin login returns to the admin dashboard and loads protected driver/restaurant queues with the session token");

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
  await page.getByText("Nuk ka dokumente, automjete ose aplikime në pritje.").waitFor({ state: "visible" });
  await page.getByText("Nuk ka aplikime restorantesh në pritje.").waitFor({ state: "visible" });
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
  assert.ok(driverSource.includes('JSON.stringify({online:true,mode:next})'), "online mode changes must use the server-authoritative availability endpoint");
  assert.ok(driverSource.includes('DRIVER_HAS_ACTIVE_JOB'), "driver mode changes must explain when an active job blocks switching");
  const driverHtmlResponse = await page.request.get(new URL("driver/", baseUrl).toString());
  assert.equal(driverHtmlResponse.status(), 200, "driver portal markup should load");
  const driverHtml = await driverHtmlResponse.text();
  assert.match(driverHtml, /ndërrimi i modalitetit zbatohet menjëherë/, "driver portal must explain online mode switching");
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
  await page.route(`${apiOrigin}/geocode`, async route => {
    const requestBody = JSON.parse(route.request().postData() || "{}");
    const query = String(requestBody.query || "").toLowerCase();
    const pickup = query.includes("nisja");
    const updatedPickup = pickup && query.includes("e re");
    const thirdPickup = pickup && query.includes("tjetër");
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: [{
        label: pickup ? (thirdPickup ? "Rruga tjetër, Ferizaj" : updatedPickup ? "Rruga e Re, Ferizaj" : "Rruga A, Ferizaj") : "Sheshi, Ferizaj",
        lat: pickup ? (thirdPickup ? 42.3733 : updatedPickup ? 42.3722 : 42.3702) : 42.3712,
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
    const quoteId = ["44444444-4444-4444-8444-444444444444", "66666666-6666-4666-8666-666666666666", "77777777-7777-4777-8777-777777777777", "88888888-8888-4888-8888-888888888888"][quoteNumber - 1];
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
        expires_at: "2026-11-11T09:05:00Z",
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
  await quoteConfirm.waitFor({ state: "visible" });
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
  console.log("PASS ride flow validates coordinates, invalidates stale quotes after address/vehicle changes, ignores stale in-flight quotes, retries booking idempotently and opens the saved trip");

  await page.unroute(`${apiOrigin}/auth/login`);
  await page.unroute(`${apiOrigin}/geocode`);
  await page.unroute(`${apiOrigin}/ride-quotes`);
  await page.unroute(`${apiOrigin}/rides`);

  assert.deepEqual(missingAssets, [], "Pages must not return 4xx/5xx for local portal files");
  assert.deepEqual(pageErrors, [], "portal pages must not raise uncaught JavaScript errors");
  console.log("PASS no broken local assets and no uncaught browser JavaScript errors");
} finally {
  await browser.close();
}
