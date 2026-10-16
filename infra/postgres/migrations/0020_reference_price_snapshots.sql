BEGIN;

CREATE TABLE reference_price_snapshots (
  snapshot_id text PRIMARY KEY,
  algorithm_version integer NOT NULL CHECK (algorithm_version > 0),
  base_asset text NOT NULL,
  quote_asset text NOT NULL CHECK (quote_asset = 'USD'),
  as_of utc_timestamp NOT NULL,
  status text NOT NULL CHECK (status IN ('PUBLISHED', 'WITHHELD')),
  price numeric(38, 18),
  confidence_low numeric(38, 18),
  confidence_high numeric(38, 18),
  uncertainty_bps numeric(38, 18),
  quality_score numeric(38, 18) NOT NULL CHECK (quality_score >= 0 AND quality_score <= 1),
  evidence_refs jsonb NOT NULL,
  config_hash content_hash NOT NULL,
  estimate jsonb NOT NULL,
  content_hash content_hash NOT NULL UNIQUE,
  CHECK ((status = 'PUBLISHED') = (price IS NOT NULL)),
  CHECK ((status = 'PUBLISHED') = (confidence_low IS NOT NULL)),
  CHECK ((status = 'PUBLISHED') = (confidence_high IS NOT NULL))
);

CREATE INDEX reference_price_snapshots_point_in_time
  ON reference_price_snapshots (base_asset, as_of DESC);

CREATE TRIGGER reference_price_snapshots_immutable
  BEFORE UPDATE OR DELETE ON reference_price_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
