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

  // Use integer arithmetic so valid large inputs cannot lose cents to floating-point rounding.
  const roundedRatio = (units: number, rateCents: number, divisor: bigint): number => {
    const numerator = BigInt(units) * BigInt(rateCents);
    const rounded = (numerator + divisor / 2n) / divisor;
    if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RangeError("Calculated fare component exceeds safe integer range");
    }
    return Number(rounded);
  };
  const distanceCents = roundedRatio(input.distanceMeters, rule.perKmCents, 1000n);
  const timeCents = roundedRatio(input.durationSeconds, rule.perMinuteCents, 60n);
  const totalCents = BigInt(rule.baseFareCents) + BigInt(distanceCents) + BigInt(timeCents);
  if (totalCents > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Calculated fare exceeds safe integer range");
  const amountCents = Math.max(rule.minimumFareCents, Number(totalCents));
  return {
    pricingKind: "estimated",
    amountCents,
    currency: "EUR",
    distanceMeters: input.distanceMeters,
    durationSeconds: input.durationSeconds,
    pricingVersion: rule.version,
  };
}
