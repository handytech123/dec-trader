BEGIN;

CREATE TABLE filtered_transaction_normalizations (
  provider_id text NOT NULL,
  filter_id text NOT NULL,
  signature text NOT NULL,
  parser_version integer NOT NULL CHECK (parser_version > 0),
  raw_block_hash content_hash NOT NULL REFERENCES raw_objects(object_hash),
  event_count integer NOT NULL CHECK (event_count >= 0),
  normalized_at utc_timestamp NOT NULL,
  record_hash content_hash NOT NULL UNIQUE,
  PRIMARY KEY (provider_id, filter_id, signature, parser_version),
  FOREIGN KEY (provider_id, filter_id, signature)
    REFERENCES filtered_transaction_reconciliations(provider_id, filter_id, signature)
);

CREATE INDEX filtered_transaction_normalizations_signature
  ON filtered_transaction_normalizations (signature, normalized_at DESC);

CREATE TRIGGER filtered_transaction_normalizations_immutable
  BEFORE UPDATE OR DELETE ON filtered_transaction_normalizations
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

CREATE TABLE filtered_transaction_capital_events (
  provider_id text NOT NULL,
  filter_id text NOT NULL,
  signature text NOT NULL,
  parser_version integer NOT NULL CHECK (parser_version > 0),
  event_id text NOT NULL REFERENCES capital_events(event_id),
  PRIMARY KEY (provider_id, filter_id, signature, parser_version, event_id),
  FOREIGN KEY (provider_id, filter_id, signature, parser_version)
    REFERENCES filtered_transaction_normalizations(provider_id, filter_id, signature, parser_version)
);

CREATE INDEX filtered_transaction_capital_events_event
  ON filtered_transaction_capital_events (event_id);

CREATE TRIGGER filtered_transaction_capital_events_immutable
  BEFORE UPDATE OR DELETE ON filtered_transaction_capital_events
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
