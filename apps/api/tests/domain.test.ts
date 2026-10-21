import test from "node:test";
import assert from "node:assert/strict";
import { calculateRideQuote } from "../src/domain/pricing.ts";
import { canTransitionRide, canTransitionFoodOrder, assertRideTransition } from "../src/domain/state-machines.ts";

const estimateRule = {
  kind: "estimated" as const,
  baseFareCents: 150,
  minimumFareCents: 250,
  perKmCents: 80,
  perMinuteCents: 20,
  version: "city-v1",
  active: true,
};

test("fixed route price takes precedence for exact active route", () => {
  const quote = calculateRideQuote({
    routeKey: "prishtina-airport",
    distanceMeters: 18000,
    durationSeconds: 1500,
    fixedRouteRule: { kind: "fixed_route", routeKey: "prishtina-airport", amountCents: 1200, version: "fixed-v3", active: true },
    estimateRule,
  });
  assert.equal(quote.amountCents, 1200);
  assert.equal(quote.pricingKind, "fixed_route");
  assert.equal(quote.pricingVersion, "fixed-v3");
});

test("estimated fare uses distance and time then applies minimum", () => {
  const quote = calculateRideQuote({ routeKey: "unconfigured", distanceMeters: 5000, durationSeconds: 600, estimateRule });
  assert.equal(quote.amountCents, 150 + 400 + 200);
  assert.equal(quote.pricingKind, "estimated");
  const short = calculateRideQuote({ routeKey: "short", distanceMeters: 0, durationSeconds: 0, estimateRule });
  assert.equal(short.amountCents, 250);
});

test("inactive fixed route falls back to estimate", () => {
  const quote = calculateRideQuote({
    routeKey: "r1",
    distanceMeters: 1000,
    durationSeconds: 60,
    fixedRouteRule: { kind: "fixed_route", routeKey: "r1", amountCents: 1, version: "old", active: false },
    estimateRule,
  });
  assert.equal(quote.pricingKind, "estimated");
});

test("invalid distance is rejected", () => {
  assert.throws(() => calculateRideQuote({ routeKey: "x", distanceMeters: -1, durationSeconds: 10, estimateRule }), RangeError);
});

test("ride cannot jump directly from searching to completed", () => {
  assert.equal(canTransitionRide("searching", "completed"), false);
  assert.throws(() => assertRideTransition("searching", "completed"), /Invalid ride transition/);
});

test("food order follows restaurant acceptance before courier assignment", () => {
  assert.equal(canTransitionFoodOrder("submitted", "accepted"), true);
  assert.equal(canTransitionFoodOrder("submitted", "courier_assigned"), false);
  assert.equal(canTransitionFoodOrder("ready_for_pickup", "courier_assigned"), true);
  assert.equal(canTransitionFoodOrder("delivered", "picked_up"), false);
});

test("estimated fare uses exact integer rounding for large valid components", () => {
  const quote = calculateRideQuote({
    routeKey: "large-but-safe",
    distanceMeters: 500,
    durationSeconds: 0,
    estimateRule: {
      ...estimateRule,
      baseFareCents: 0,
      minimumFareCents: 0,
      perKmCents: Number.MAX_SAFE_INTEGER,
      perMinuteCents: 0,
    },
  });
  assert.equal(quote.amountCents, 4503599627370496);
});
