BEGIN;
CREATE TABLE route_sellability_assessments (
  mint text NOT NULL,
  assessed_at utc_timestamp NOT NULL,
  provider text NOT NULL,
  notional_usdc_atomic atomic_quantity NOT NULL,
  buy_output_atomic atomic_quantity,
  sell_output_usdc_atomic atomic_quantity,
  round_trip_loss_bps numeric(38, 18),
  buy_price_impact_pct numeric(38, 18),
  sell_price_impact_pct numeric(38, 18),
  status text NOT NULL CHECK (status IN ('PASS', 'REVIEW', 'BLOCK')),
  reason text,
  raw_hash content_hash,
  PRIMARY KEY (mint, assessed_at, provider)
);
CREATE INDEX route_sellability_latest ON route_sellability_assessments (mint, assessed_at DESC);
COMMIT;
