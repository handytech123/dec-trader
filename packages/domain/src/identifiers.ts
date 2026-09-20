import { z } from "zod";

// The expression is anchored and applied to small identifier inputs; nested groups cannot overlap.
// eslint-disable-next-line security/detect-unsafe-regex
const identifierPattern = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*_[0-9A-HJKMNP-TV-Z]{26}$/;

export const DomainIdSchema = z.string().regex(identifierPattern, "expected a prefixed ULID");
export type DomainId = z.infer<typeof DomainIdSchema>;

export const Sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export type Sha256 = z.infer<typeof Sha256Schema>;

export const IsoTimestampSchema = z.iso
  .datetime({ offset: true })
  .refine((value) => value.endsWith("Z"), "timestamps must be normalized to UTC (Z)");
