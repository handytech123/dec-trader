import { Decimal } from "decimal.js";
import { z } from "zod";
import { contentHash, DecimalSchema, Sha256Schema } from "@autonomous-trading-lab/domain";

const PositiveDecimalSchema = DecimalSchema.refine((value) => new Decimal(value).gt(0));
type ContentHash = `sha256:${string}`;
const ContentHashSchema = Sha256Schema.transform((value) => value as ContentHash);

export const ReferencePriceObservationSchema = z
  .object({
    venue: z.string().min(1).max(100),
    instrumentId: z.string().min(1).max(100),
    baseAsset: z.string().min(1).max(20),
    quoteAsset: z.enum(["USD", "USDT"]),
    kind: z.enum(["TRADE", "BOOK"]),
    price: PositiveDecimalSchema,
    bid: PositiveDecimalSchema.optional(),
    ask: PositiveDecimalSchema.optional(),
    observedAt: z.iso.datetime({ offset: true }),
    evidenceRef: ContentHashSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === "BOOK" && (value.bid === undefined || value.ask === undefined))
      context.addIssue({ code: "custom", message: "book observations require bid and ask" });
    if (value.bid !== undefined && value.ask !== undefined && new Decimal(value.bid).gt(value.ask))
      context.addIssue({ code: "custom", message: "bid must not exceed ask" });
  });
export type ReferencePriceObservation = z.infer<typeof ReferencePriceObservationSchema>;

export const QuoteBasisObservationSchema = z
  .object({
    quoteAsset: z.literal("USDT"),
    usdPerQuote: PositiveDecimalSchema,
    observedAt: z.iso.datetime({ offset: true }),
    evidenceRef: ContentHashSchema,
  })
  .strict();
export type QuoteBasisObservation = z.infer<typeof QuoteBasisObservationSchema>;

export const ReferencePriceConfigSchema = z
  .object({
    baseAsset: z.string().min(1).max(20),
    asOf: z.iso.datetime({ offset: true }),
    minimumVenues: z.number().int().min(2).max(20),
    maximumAgeMs: z.number().int().min(100).max(300_000),
    maximumBasisAgeMs: z.number().int().min(100).max(300_000),
    maximumDeviationBps: z.number().int().min(1).max(10_000),
    maximumSpreadBps: z.number().int().min(1).max(10_000),
  })
  .strict();
export type ReferencePriceConfig = z.infer<typeof ReferencePriceConfigSchema>;

export interface ReferenceVenueEstimate {
  readonly venue: string;
  readonly priceUsd: string;
  readonly observationCount: number;
  readonly maximumAgeMs: number;
  readonly maximumSpreadBps: string;
  readonly evidenceRefs: readonly `sha256:${string}`[];
}

export interface ReferencePriceEstimate {
  readonly algorithmVersion: "1";
  readonly status: "PUBLISHED" | "WITHHELD";
  readonly baseAsset: string;
  readonly quoteAsset: "USD";
  readonly asOf: string;
  readonly price: string | null;
  readonly confidenceLow: string | null;
  readonly confidenceHigh: string | null;
  readonly uncertaintyBps: string | null;
  readonly qualityScore: string;
  readonly venueEstimates: readonly ReferenceVenueEstimate[];
  readonly rejected: readonly {
    readonly evidenceRef: `sha256:${string}`;
    readonly reason: string;
  }[];
  readonly reasons: readonly string[];
  readonly evidenceRefs: readonly `sha256:${string}`[];
  readonly configHash: `sha256:${string}`;
  readonly contentHash: `sha256:${string}`;
}

interface ConvertedObservation {
  readonly venue: string;
  readonly price: Decimal;
  readonly ageMs: number;
  readonly spreadBps: Decimal;
  readonly evidenceRef: `sha256:${string}`;
}

function median(values: readonly Decimal[]): Decimal {
  if (values.length === 0) throw new Error("median requires at least one value");
  const ordered = [...values].sort((left, right) => left.comparedTo(right));
  const middle = Math.floor(ordered.length / 2);
  // middle is derived from this same non-empty local array.
  // eslint-disable-next-line security/detect-object-injection
  const value = ordered[middle];
  if (!value) throw new Error("median index unexpectedly absent");
  if (ordered.length % 2 === 1) return value;
  const previous = ordered[middle - 1];
  if (!previous) throw new Error("median lower index unexpectedly absent");
  return previous.plus(value).div(2);
}

function basisFor(
  quoteAsset: "USD" | "USDT",
  basis: QuoteBasisObservation | undefined,
  asOfMs: number,
  maximumAgeMs: number,
): { rate: Decimal; evidenceRef?: `sha256:${string}` } | undefined {
  if (quoteAsset === "USD") return { rate: new Decimal(1) };
  if (!basis) return undefined;
  const age = asOfMs - new Date(basis.observedAt).getTime();
  if (age < 0 || age > maximumAgeMs) return undefined;
  return { rate: new Decimal(basis.usdPerQuote), evidenceRef: basis.evidenceRef };
}

export function computeReferencePrice(
  observationCandidates: readonly ReferencePriceObservation[],
  basisCandidate: QuoteBasisObservation | undefined,
  configCandidate: ReferencePriceConfig,
): ReferencePriceEstimate {
  const config = ReferencePriceConfigSchema.parse(configCandidate);
  const observations = observationCandidates.map((candidate) =>
    ReferencePriceObservationSchema.parse(candidate),
  );
  const basis = basisCandidate ? QuoteBasisObservationSchema.parse(basisCandidate) : undefined;
  const asOfMs = new Date(config.asOf).getTime();
  const rejected: { evidenceRef: `sha256:${string}`; reason: string }[] = [];
  const converted: ConvertedObservation[] = [];
  const basisRefs = new Set<`sha256:${string}`>();
  for (const observation of observations) {
    if (observation.baseAsset !== config.baseAsset) {
      rejected.push({ evidenceRef: observation.evidenceRef, reason: "BASE_ASSET_MISMATCH" });
      continue;
    }
    const ageMs = asOfMs - new Date(observation.observedAt).getTime();
    if (ageMs < 0) {
      rejected.push({ evidenceRef: observation.evidenceRef, reason: "FUTURE_OBSERVATION" });
      continue;
    }
    if (ageMs > config.maximumAgeMs) {
      rejected.push({ evidenceRef: observation.evidenceRef, reason: "STALE_OBSERVATION" });
      continue;
    }
    const conversion = basisFor(observation.quoteAsset, basis, asOfMs, config.maximumBasisAgeMs);
    if (!conversion) {
      rejected.push({
        evidenceRef: observation.evidenceRef,
        reason: "MISSING_OR_STALE_QUOTE_BASIS",
      });
      continue;
    }
    if (conversion.evidenceRef) basisRefs.add(conversion.evidenceRef);
    const price = new Decimal(observation.price).mul(conversion.rate);
    const spreadBps =
      observation.bid && observation.ask
        ? new Decimal(observation.ask)
            .minus(observation.bid)
            .div(new Decimal(observation.ask).plus(observation.bid).div(2))
            .mul(10_000)
        : new Decimal(0);
    if (spreadBps.gt(config.maximumSpreadBps)) {
      rejected.push({ evidenceRef: observation.evidenceRef, reason: "SPREAD_TOO_WIDE" });
      continue;
    }
    converted.push({
      venue: observation.venue,
      price,
      ageMs,
      spreadBps,
      evidenceRef: observation.evidenceRef,
    });
  }
  const byVenue = new Map<string, ConvertedObservation[]>();
  for (const observation of converted) {
    const values = byVenue.get(observation.venue) ?? [];
    values.push(observation);
    byVenue.set(observation.venue, values);
  }
  const preliminary = [...byVenue.entries()].map(([venue, values]) => ({
    venue,
    price: median(values.map((value) => value.price)),
    values,
  }));
  const center = preliminary.length > 0 ? median(preliminary.map((item) => item.price)) : undefined;
  const accepted = preliminary.filter((item) => {
    if (!center) return false;
    const deviation = item.price.minus(center).abs().div(center).mul(10_000);
    if (deviation.lte(config.maximumDeviationBps)) return true;
    for (const value of item.values)
      rejected.push({ evidenceRef: value.evidenceRef, reason: "VENUE_PRICE_OUTLIER" });
    return false;
  });
  const reference = accepted.length > 0 ? median(accepted.map((item) => item.price)) : undefined;
  const venueEstimates: ReferenceVenueEstimate[] = accepted
    .map((item) => ({
      venue: item.venue,
      priceUsd: item.price.toString(),
      observationCount: item.values.length,
      maximumAgeMs: Math.max(...item.values.map((value) => value.ageMs)),
      maximumSpreadBps: Decimal.max(...item.values.map((value) => value.spreadBps)).toString(),
      evidenceRefs: item.values.map((value) => value.evidenceRef).sort(),
    }))
    .sort((left, right) => left.venue.localeCompare(right.venue));
  const reasons: string[] = [];
  if (accepted.length < config.minimumVenues) reasons.push("INSUFFICIENT_INDEPENDENT_VENUES");
  if (!reference) reasons.push("NO_VALID_PRICE_OBSERVATIONS");
  const status: "PUBLISHED" | "WITHHELD" = reasons.length === 0 ? "PUBLISHED" : "WITHHELD";
  const deviations = reference
    ? accepted.map((item) => item.price.minus(reference).abs().div(reference).mul(10_000))
    : [];
  const spreads = accepted.flatMap((item) => item.values.map((value) => value.spreadBps.div(2)));
  const uncertainty = reference
    ? Decimal.max(
        new Decimal(1),
        ...(deviations.length > 0 ? deviations : [new Decimal(0)]),
        ...spreads,
      )
    : undefined;
  const freshnessScore =
    accepted.length === 0
      ? new Decimal(0)
      : new Decimal(1).minus(
          new Decimal(
            Math.max(...accepted.flatMap((item) => item.values.map((value) => value.ageMs))),
          ).div(config.maximumAgeMs),
        );
  const coverageScore = Decimal.min(1, new Decimal(accepted.length).div(config.minimumVenues));
  const agreementScore = uncertainty
    ? Decimal.max(0, new Decimal(1).minus(uncertainty.div(config.maximumDeviationBps)))
    : new Decimal(0);
  const qualityScore = Decimal.max(
    0,
    Decimal.min(
      1,
      coverageScore.mul("0.4").plus(freshnessScore.mul("0.3")).plus(agreementScore.mul("0.3")),
    ),
  );
  const evidenceRefs = [
    ...new Set([...venueEstimates.flatMap((item) => item.evidenceRefs), ...basisRefs]),
  ].sort();
  const withoutHash = {
    algorithmVersion: "1" as const,
    status,
    baseAsset: config.baseAsset,
    quoteAsset: "USD" as const,
    asOf: config.asOf,
    price: status === "PUBLISHED" && reference ? reference.toString() : null,
    confidenceLow:
      status === "PUBLISHED" && reference && uncertainty
        ? reference.mul(new Decimal(1).minus(uncertainty.div(10_000))).toString()
        : null,
    confidenceHigh:
      status === "PUBLISHED" && reference && uncertainty
        ? reference.mul(new Decimal(1).plus(uncertainty.div(10_000))).toString()
        : null,
    uncertaintyBps: status === "PUBLISHED" && uncertainty ? uncertainty.toString() : null,
    qualityScore: qualityScore.toString(),
    venueEstimates,
    rejected: rejected.sort((left, right) =>
      `${left.evidenceRef}:${left.reason}`.localeCompare(`${right.evidenceRef}:${right.reason}`),
    ),
    reasons,
    evidenceRefs,
    configHash: contentHash(config),
  };
  return { ...withoutHash, contentHash: contentHash(withoutHash) };
}
