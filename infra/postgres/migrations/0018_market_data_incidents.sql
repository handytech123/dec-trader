BEGIN;

CREATE TABLE market_data_incidents (
  incident_id text PRIMARY KEY,
  incident_type text NOT NULL CHECK (incident_type IN ('SEQUENCE_GAP', 'RECONNECT')),
  source text NOT NULL,
  venue text NOT NULL,
  product_id text,
  expected_sequence numeric(38, 0),
  received_sequence numeric(38, 0),
  detected_at utc_timestamp NOT NULL,
  details jsonb NOT NULL,
  record_hash content_hash NOT NULL UNIQUE
);

CREATE INDEX market_data_incidents_time
  ON market_data_incidents (venue, product_id, detected_at DESC);

CREATE TRIGGER market_data_incidents_immutable
  BEFORE UPDATE OR DELETE ON market_data_incidents
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
