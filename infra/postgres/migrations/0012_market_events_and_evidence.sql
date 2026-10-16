BEGIN;

CREATE TABLE canonical_market_events (
  event_id text PRIMARY KEY,
  event_time utc_timestamp NOT NULL,
  ingest_time utc_timestamp NOT NULL,
  source text NOT NULL,
  venue text NOT NULL,
  instrument_id text NOT NULL,
  event_type text NOT NULL,
  price numeric(38, 18) CHECK (price >= 0),
  quantity numeric(38, 18) CHECK (quantity >= 0),
  side text CHECK (side IN ('BUY', 'SELL')),
  bid numeric(38, 18) CHECK (bid >= 0),
  ask numeric(38, 18) CHECK (ask >= 0),
  book_sequence numeric(38, 0) CHECK (book_sequence >= 0),
  raw_ref content_hash NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  record_hash content_hash NOT NULL UNIQUE
);
CREATE INDEX canonical_market_events_point_in_time
  ON canonical_market_events (instrument_id, event_time, event_id);

CREATE TABLE order_book_snapshots (
  venue text NOT NULL,
  instrument_id text NOT NULL,
  sequence numeric(38, 0) NOT NULL CHECK (sequence >= 0),
  observed_at utc_timestamp NOT NULL,
  bids jsonb NOT NULL,
  asks jsonb NOT NULL,
  algorithm_version integer NOT NULL CHECK (algorithm_version > 0),
  input_refs jsonb NOT NULL,
  content_hash content_hash NOT NULL UNIQUE,
  PRIMARY KEY (venue, instrument_id, sequence)
);

CREATE TABLE evidence_packets (
  packet_id text PRIMARY KEY,
  packet_version integer NOT NULL CHECK (packet_version > 0),
  detected_event_id text NOT NULL,
  generated_at utc_timestamp NOT NULL,
  packet jsonb NOT NULL,
  content_hash content_hash NOT NULL UNIQUE
);

CREATE TRIGGER canonical_market_events_immutable
  BEFORE UPDATE OR DELETE ON canonical_market_events
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();
CREATE TRIGGER order_book_snapshots_immutable
  BEFORE UPDATE OR DELETE ON order_book_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();
CREATE TRIGGER evidence_packets_immutable
  BEFORE UPDATE OR DELETE ON evidence_packets
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
