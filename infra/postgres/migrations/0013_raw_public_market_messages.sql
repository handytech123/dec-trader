BEGIN;

CREATE TABLE raw_public_market_messages (
  raw_ref content_hash PRIMARY KEY,
  source text NOT NULL,
  venue text NOT NULL,
  product_id text,
  message_type text NOT NULL,
  sequence numeric(38, 0),
  observed_at utc_timestamp,
  ingested_at utc_timestamp NOT NULL,
  payload jsonb NOT NULL
);

CREATE INDEX raw_public_market_messages_point_in_time
  ON raw_public_market_messages (venue, product_id, ingested_at, raw_ref);

CREATE TRIGGER raw_public_market_messages_immutable
  BEFORE UPDATE OR DELETE ON raw_public_market_messages
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
