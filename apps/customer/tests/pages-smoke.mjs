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

  const apiOrigin = "https://saavqlbwffrwxingbnri.supabase.co/functions/v1/sjelle-api/api/v1";
  const adminRequests = [];
  await page.route(`${apiOrigin}/**`, async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname.replace("/functions/v1/sjelle-api/api/v1", "");
    if (pathname === "/auth/login") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: { access_token: "sjelle-admin-smoke-token", refresh_token: "sjelle-admin-smoke-refresh", expires_in: 3600, user: { id: "smoke-admin", email: "admin-smoke@example.test" } } }) });
    }
    if (!request.headers().authorization?.includes("sjelle-admin-smoke-token")) {
      return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "UNAUTHENTICATED" } }) });
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
  assert.ok(adminRequests.includes("/admin/driver-documents"), "admin login must load the protected driver application queue");
  assert.ok(adminRequests.includes("/admin/restaurants"), "admin login must load the protected restaurant application queue");
  assert.match(await page.locator("#admin-alert").textContent(), /Paneli administrativ u ngarkua/i, "admin dashboard should report a successful protected load");
  console.log("PASS admin login returns to the admin dashboard and loads protected driver/restaurant queues with the session token");
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

  assert.deepEqual(missingAssets, [], "Pages must not return 4xx/5xx for local portal files");
  assert.deepEqual(pageErrors, [], "portal pages must not raise uncaught JavaScript errors");
  console.log("PASS no broken local assets and no uncaught browser JavaScript errors");
} finally {
  await browser.close();
}
