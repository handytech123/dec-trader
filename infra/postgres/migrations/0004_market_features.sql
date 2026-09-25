BEGIN;

ALTER TABLE discovered_assets
  ADD COLUMN research_role text NOT NULL DEFAULT 'CANDIDATE'
    CHECK (research_role IN ('CANDIDATE', 'BENCHMARK', 'CONTROL'));

CREATE TABLE market_feature_snapshots (
  source_record_hash content_hash NOT NULL REFERENCES dex_market_observations(record_hash),
  pool_id text NOT NULL REFERENCES discovered_pools(pool_id),
  configured_mint text NOT NULL,
  as_of utc_timestamp NOT NULL,
  feature_version integer NOT NULL CHECK (feature_version > 0),
  values jsonb NOT NULL,
  content_hash content_hash NOT NULL UNIQUE,
  PRIMARY KEY (source_record_hash, feature_version)
);

CREATE INDEX market_feature_snapshots_asset_time
  ON market_feature_snapshots (configured_mint, as_of);

COMMIT;
