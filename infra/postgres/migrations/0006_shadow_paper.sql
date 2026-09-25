BEGIN;
CREATE TABLE shadow_decisions (
  decision_id text PRIMARY KEY,
  source_record_hash content_hash NOT NULL REFERENCES dex_market_observations(record_hash),
  mint text NOT NULL,
  evaluated_at utc_timestamp NOT NULL,
  strategy_version text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('ENTER', 'NO_TRADE')),
  reasons jsonb NOT NULL,
  values jsonb NOT NULL,
  UNIQUE (source_record_hash, strategy_version)
);
CREATE TABLE paper_positions (
  position_id text PRIMARY KEY,
  mint text NOT NULL,
  pool_id text NOT NULL REFERENCES discovered_pools(pool_id),
  strategy_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN', 'CLOSED')),
  opened_at utc_timestamp NOT NULL,
  open_record_hash content_hash NOT NULL REFERENCES dex_market_observations(record_hash),
  entry_price numeric(38, 18) NOT NULL CHECK (entry_price > 0),
  notional_usd numeric(38, 18) NOT NULL CHECK (notional_usd > 0),
  entry_cost_bps integer NOT NULL CHECK (entry_cost_bps >= 0),
  closed_at utc_timestamp,
  close_record_hash content_hash REFERENCES dex_market_observations(record_hash),
  exit_price numeric(38, 18),
  exit_cost_bps integer CHECK (exit_cost_bps >= 0),
  net_pnl_usd numeric(38, 18),
  CHECK ((status = 'OPEN' AND closed_at IS NULL AND net_pnl_usd IS NULL) OR
         (status = 'CLOSED' AND closed_at IS NOT NULL AND net_pnl_usd IS NOT NULL))
);
CREATE UNIQUE INDEX one_open_paper_position_per_mint
  ON paper_positions (mint) WHERE status = 'OPEN';
COMMIT;
