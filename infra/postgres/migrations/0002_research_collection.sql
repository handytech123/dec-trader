BEGIN;

CREATE TABLE discovered_assets (
  chain text NOT NULL CHECK (chain = 'solana'),
  mint text NOT NULL,
  symbol text,
  category text,
  market_cap_tier text,
  first_observed_at utc_timestamp NOT NULL,
  last_observed_at utc_timestamp NOT NULL,
  status text NOT NULL DEFAULT 'CANDIDATE'
    CHECK (status IN ('CANDIDATE', 'VERIFIED', 'REJECTED', 'INACTIVE')),
  PRIMARY KEY (chain, mint)
);

CREATE TABLE discovered_pools (
  pool_id text PRIMARY KEY,
  chain text NOT NULL CHECK (chain = 'solana'),
  dex_id text NOT NULL,
  pair_address text NOT NULL,
  base_mint text NOT NULL,
  quote_mint text NOT NULL,
  first_observed_at utc_timestamp NOT NULL,
  UNIQUE (chain, dex_id, pair_address)
);

CREATE TABLE collection_runs (
  collection_run_id text PRIMARY KEY,
  source text NOT NULL,
  started_at utc_timestamp NOT NULL,
  completed_at utc_timestamp,
  requested_assets integer NOT NULL CHECK (requested_assets >= 0),
  captured_observations integer NOT NULL DEFAULT 0 CHECK (captured_observations >= 0),
  error_count integer NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  status text NOT NULL CHECK (status IN ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE dex_market_observations (
  record_hash content_hash PRIMARY KEY,
  observation_id text NOT NULL,
  raw_record_hash content_hash NOT NULL REFERENCES raw_observations(record_hash),
  configured_mint text NOT NULL,
  pool_id text NOT NULL REFERENCES discovered_pools(pool_id),
  observed_at utc_timestamp NOT NULL,
  price numeric(38, 18) NOT NULL CHECK (price >= 0),
  volume_24h numeric(38, 18),
  liquidity_usd numeric(38, 18) NOT NULL CHECK (liquidity_usd >= 0),
  market_cap numeric(38, 18),
  fdv numeric(38, 18),
  price_change_5m numeric(38, 18),
  price_change_1h numeric(38, 18),
  price_change_6h numeric(38, 18),
  price_change_24h numeric(38, 18),
  buys_5m integer,
  sells_5m integer,
  buys_1h integer,
  sells_1h integer,
  buys_6h integer,
  sells_6h integer,
  buys_24h integer,
  sells_24h integer,
  pair_created_at utc_timestamp,
  source text NOT NULL,
  UNIQUE (observation_id, pool_id)
);

CREATE INDEX dex_market_observations_point_in_time
  ON dex_market_observations (configured_mint, observed_at);
CREATE INDEX dex_market_observations_pool_time
  ON dex_market_observations (pool_id, observed_at);

CREATE TABLE collection_errors (
  collection_error_id text PRIMARY KEY,
  collection_run_id text NOT NULL REFERENCES collection_runs(collection_run_id),
  mint text,
  occurred_at utc_timestamp NOT NULL,
  error_code text NOT NULL,
  message text NOT NULL
);

COMMIT;
