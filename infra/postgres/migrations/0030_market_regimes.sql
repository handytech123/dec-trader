BEGIN;

CREATE TABLE market_regime_snapshots (
  regime_id text PRIMARY KEY,
  as_of utc_timestamp NOT NULL,
  window_seconds integer NOT NULL CHECK (window_seconds >= 60),
  state text NOT NULL CHECK (state IN ('RISING', 'FALLING', 'VOLATILE', 'QUIET', 'INSUFFICIENT_DATA')),
  sample_size integer NOT NULL CHECK (sample_size >= 0),
  return_pct numeric(38, 18),
  realized_volatility_pct numeric(38, 18),
  evidence_refs jsonb NOT NULL,
  config_hash content_hash NOT NULL,
  result jsonb NOT NULL,
  content_hash content_hash NOT NULL UNIQUE,
  UNIQUE (as_of, window_seconds, config_hash)
);

CREATE INDEX market_regime_snapshots_time ON market_regime_snapshots (as_of DESC);

CREATE TRIGGER market_regime_snapshots_immutable
  BEFORE UPDATE OR DELETE ON market_regime_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
