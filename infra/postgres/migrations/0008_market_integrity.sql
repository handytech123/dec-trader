BEGIN;
CREATE TABLE token_market_integrity_assessments (
  mint text NOT NULL,
  assessed_at utc_timestamp NOT NULL,
  provider text NOT NULL,
  status text NOT NULL CHECK (status IN ('PASS', 'REVIEW', 'BLOCK')),
  reasons jsonb NOT NULL,
  holder_count bigint,
  top_holders_percentage numeric(38, 18),
  organic_score numeric(38, 18),
  organic_score_label text,
  is_verified boolean,
  is_suspicious boolean,
  provider_updated_at utc_timestamp,
  raw_hash content_hash,
  PRIMARY KEY (mint, assessed_at, provider)
);
CREATE INDEX token_market_integrity_latest
  ON token_market_integrity_assessments (mint, assessed_at DESC);
COMMIT;
