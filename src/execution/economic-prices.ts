import type { ArbLeg, Venue } from "../types";

function roundPrice(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function boundedBinaryPrice(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function economicFillPriceForLeg(
  venue: Venue,
  direction: ArbLeg["direction"],
  fillPrice: number | null | undefined,
  referenceAsk?: number | null,
): number | null {
  if (fillPrice == null || !Number.isFinite(fillPrice)) return null;
  const normalized = fillPrice > 1 ? fillPrice / 100 : fillPrice;
  const bounded = boundedBinaryPrice(normalized);
  if (venue !== "kalshi" || direction !== "no") return roundPrice(bounded);
  if (bounded <= 0.5) return roundPrice(bounded);

  const inverted = roundPrice(boundedBinaryPrice(1 - bounded));
  const direct = roundPrice(bounded);
  if (referenceAsk != null && Number.isFinite(referenceAsk)) {
    return Math.abs(inverted - referenceAsk) + 1e-9 < Math.abs(direct - referenceAsk) ? inverted : direct;
  }
  return direct;
}

export function economicFillPriceForSignalVenue<T extends { lower: ArbLeg; higher: ArbLeg }>(
  signal: T,
  venue: Venue,
  fillPrice: number | null | undefined,
): number | null {
  const leg = signal.lower.venue === venue ? signal.lower : signal.higher.venue === venue ? signal.higher : null;
  if (!leg) return fillPrice == null ? null : economicFillPriceForLeg(venue, "yes", fillPrice);
  return economicFillPriceForLeg(venue, leg.direction, fillPrice, leg.ask);
}
