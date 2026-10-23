export type RentalBookingStatus =
  | "requested" | "confirmed" | "declined" | "cancelled"
  | "picked_up" | "returned" | "no_show";

export interface RentalQuoteInput {
  pickupAt: string | Date;
  returnAt: string | Date;
  dailyPriceCents: number;
  depositCents?: number;
}

export interface RentalQuote {
  rentalDays: number;
  dailyPriceCents: number;
  depositCents: number;
  rentalTotalCents: number;
  totalDueCents: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Rental periods use calendar-day billing with a minimum of one day.
// Round up partial 24-hour periods so the quote cannot undercharge.
export function quoteRental(input: RentalQuoteInput): RentalQuote {
  const pickup = new Date(input.pickupAt).getTime();
  const returned = new Date(input.returnAt).getTime();
  if (!Number.isFinite(pickup) || !Number.isFinite(returned) || returned <= pickup) {
    throw new Error("Return time must be later than pickup time.");
  }
  if (!Number.isSafeInteger(input.dailyPriceCents) || input.dailyPriceCents <= 0) {
    throw new Error("Daily price must be a positive integer in cents.");
  }
  const deposit = input.depositCents ?? 0;
  if (!Number.isSafeInteger(deposit) || deposit < 0) {
    throw new Error("Deposit must be a non-negative integer in cents.");
  }
  const rentalDays = Math.max(1, Math.ceil((returned - pickup) / DAY_MS));
  if (rentalDays > 366) throw new Error("Rental period cannot exceed 366 days.");
  const rentalTotalCents = rentalDays * input.dailyPriceCents;
  if (!Number.isSafeInteger(rentalTotalCents + deposit)) {
    throw new Error("Rental total exceeds the supported amount.");
  }
  return {
    rentalDays,
    dailyPriceCents: input.dailyPriceCents,
    depositCents: deposit,
    rentalTotalCents,
    totalDueCents: rentalTotalCents + deposit,
  };
}

// Half-open intervals [pickup, return): back-to-back rentals are allowed.
export function rentalPeriodsOverlap(
  firstPickup: string | Date,
  firstReturn: string | Date,
  secondPickup: string | Date,
  secondReturn: string | Date,
): boolean {
  const a = new Date(firstPickup).getTime();
  const b = new Date(firstReturn).getTime();
  const c = new Date(secondPickup).getTime();
  const d = new Date(secondReturn).getTime();
  if (![a, b, c, d].every(Number.isFinite) || b <= a || d <= c) {
    throw new Error("Both rental periods must have valid, increasing dates.");
  }
  return a < d && c < b;
}

const rentalTransitions: Record<RentalBookingStatus, readonly RentalBookingStatus[]> = {
  requested: ["confirmed", "declined", "cancelled"],
  confirmed: ["cancelled", "picked_up", "no_show"],
  declined: [],
  cancelled: [],
  picked_up: ["returned"],
  returned: [],
  no_show: [],
};

export function canTransitionRentalBooking(
  from: RentalBookingStatus,
  to: RentalBookingStatus,
): boolean {
  return rentalTransitions[from].includes(to);
}

export function assertRentalBookingTransition(
  from: RentalBookingStatus,
  to: RentalBookingStatus,
): void {
  if (!canTransitionRentalBooking(from, to)) {
    throw new Error(`Invalid rental booking transition: ${from} -> ${to}`);
  }
}
