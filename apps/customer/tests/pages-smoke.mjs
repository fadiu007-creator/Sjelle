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
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    assert.ok(response && response.status() === 200, `${portal.label} should load successfully`);
    await page.locator("body").waitFor();
    await page.waitForTimeout(800);
    assert.match(await page.title(), new RegExp(portal.title, "i"), `${portal.label} title`);
    console.log(`PASS ${portal.label}: ${url}`);
  }

  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(
    () => document.querySelectorAll("#city-select option").length >= 2,
    { timeout: 15000 },
  );
  const cityOptions = await page.locator("#city-select option").count();
  assert.ok(cityOptions >= 2, "homepage should render city options from the live API");
  console.log(`PASS city selector rendered ${cityOptions - 1} city options`);

  const signupLink = page.locator('.hero-actions a[href*="account=signup"]');
  await signupLink.waitFor({ state: "visible" });
  await signupLink.click();
  await page.locator("#account-dialog[open]").waitFor({ state: "visible" });
  assert.equal(await page.locator("#auth-submit").textContent(), "Krijo llogari", "signup deep link should open signup mode");
  await page.locator("#account-close").click();
  console.log("PASS homepage signup CTA opens the real signup dialog");

  assert.deepEqual(missingAssets, [], "Pages must not return 4xx/5xx for local portal files");
  assert.deepEqual(pageErrors, [], "portal pages must not raise uncaught JavaScript errors");
  console.log("PASS no broken local assets and no uncaught browser JavaScript errors");
} finally {
  await browser.close();
}
