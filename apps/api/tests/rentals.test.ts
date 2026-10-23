import test from "node:test";
import assert from "node:assert/strict";
import { quoteRental, rentalPeriodsOverlap, canTransitionRentalBooking } from "../src/domain/rentals.js";

test("quotes round partial days up and include deposit separately", () => {
  const quote = quoteRental({
    pickupAt: "2026-10-23T10:00:00Z",
    returnAt: "2026-10-25T11:00:00Z",
    dailyPriceCents: 3500,
    depositCents: 15000,
  });
  assert.deepEqual(quote, {
    rentalDays: 3,
    dailyPriceCents: 3500,
    depositCents: 15000,
    rentalTotalCents: 10500,
    totalDueCents: 25500,
  });
});

test("rejects invalid date ranges and price values", () => {
  assert.throws(() => quoteRental({
    pickupAt: "2026-10-25T10:00:00Z",
    returnAt: "2026-10-24T10:00:00Z",
    dailyPriceCents: 3500,
  }));
  assert.throws(() => quoteRental({
    pickupAt: "2026-10-23T10:00:00Z",
    returnAt: "2026-10-24T10:00:00Z",
    dailyPriceCents: 0,
  }));
});

test("detects conflicting periods but permits consecutive bookings", () => {
  assert.equal(rentalPeriodsOverlap(
    "2026-10-23T10:00:00Z", "2026-10-25T10:00:00Z",
    "2026-10-24T09:00:00Z", "2026-10-26T10:00:00Z",
  ), true);
  assert.equal(rentalPeriodsOverlap(
    "2026-10-23T10:00:00Z", "2026-10-25T10:00:00Z",
    "2026-10-25T10:00:00Z", "2026-10-26T10:00:00Z",
  ), false);
});

test("rental booking lifecycle blocks invalid transitions", () => {
  assert.equal(canTransitionRentalBooking("requested", "confirmed"), true);
  assert.equal(canTransitionRentalBooking("confirmed", "picked_up"), true);
  assert.equal(canTransitionRentalBooking("picked_up", "returned"), true);
  assert.equal(canTransitionRentalBooking("returned", "confirmed"), false);
});
