export type RidePricingRule =
  | {
      kind: "fixed_route";
      routeKey: string;
      amountCents: number;
      version: string;
      active: boolean;
    }
  | {
      kind: "estimated";
      baseFareCents: number;
      minimumFareCents: number;
      perKmCents: number;
      perMinuteCents: number;
      version: string;
      active: boolean;
    };

export interface RideQuoteInput {
  routeKey: string;
  distanceMeters: number;
  durationSeconds: number;
  fixedRouteRule?: Extract<RidePricingRule, { kind: "fixed_route" }>;
  estimateRule: Extract<RidePricingRule, { kind: "estimated" }>;
}

export interface RideQuote {
  pricingKind: "fixed_route" | "estimated";
  amountCents: number;
  currency: "EUR";
  distanceMeters: number;
  durationSeconds: number;
  pricingVersion: string;
}

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

export function calculateRideQuote(input: RideQuoteInput): RideQuote {
  assertNonNegativeSafeInteger(input.distanceMeters, "distanceMeters");
  assertNonNegativeSafeInteger(input.durationSeconds, "durationSeconds");

  const fixed = input.fixedRouteRule;
  if (fixed?.active && fixed.routeKey === input.routeKey) {
    assertNonNegativeSafeInteger(fixed.amountCents, "fixed amountCents");
    return {
      pricingKind: "fixed_route",
      amountCents: fixed.amountCents,
      currency: "EUR",
      distanceMeters: input.distanceMeters,
      durationSeconds: input.durationSeconds,
      pricingVersion: fixed.version,
    };
  }

  const rule = input.estimateRule;
  if (!rule.active) throw new Error("No active estimated ride pricing rule");
  assertNonNegativeSafeInteger(rule.baseFareCents, "baseFareCents");
  assertNonNegativeSafeInteger(rule.minimumFareCents, "minimumFareCents");
  assertNonNegativeSafeInteger(rule.perKmCents, "perKmCents");
  assertNonNegativeSafeInteger(rule.perMinuteCents, "perMinuteCents");

  // Round each distance/time component to the nearest cent, then apply minimum.
  const distanceCents = Math.round((input.distanceMeters * rule.perKmCents) / 1000);
  const timeCents = Math.round((input.durationSeconds * rule.perMinuteCents) / 60);
  const amountCents = Math.max(rule.minimumFareCents, rule.baseFareCents + distanceCents + timeCents);

  if (!Number.isSafeInteger(amountCents)) throw new RangeError("Calculated fare exceeds safe integer range");
  return {
    pricingKind: "estimated",
    amountCents,
    currency: "EUR",
    distanceMeters: input.distanceMeters,
    durationSeconds: input.durationSeconds,
    pricingVersion: rule.version,
  };
}
