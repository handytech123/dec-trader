BEGIN;

CREATE TABLE verified_entity_addresses (
  address text NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('EXCHANGE','BRIDGE','PROTOCOL','CONTRACT','POOL')),
  label text NOT NULL,
  source text NOT NULL,
  source_url text NOT NULL,
  evidence_hash content_hash NOT NULL,
  valid_from utc_timestamp NOT NULL,
  valid_to utc_timestamp,
  retrieved_at utc_timestamp NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  record_hash content_hash NOT NULL UNIQUE,
  PRIMARY KEY (address, valid_from),
  CHECK (valid_to IS NULL OR valid_from <= valid_to)
);

CREATE INDEX verified_entity_addresses_lookup
  ON verified_entity_addresses (address, valid_from DESC, valid_to);

CREATE TRIGGER verified_entity_addresses_immutable
  BEFORE UPDATE OR DELETE ON verified_entity_addresses
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

CREATE TABLE raw_filtered_transactions (
  provider_id text NOT NULL,
  filter_id text NOT NULL,
  subscription_id bigint NOT NULL CHECK (subscription_id >= 0),
  slot bigint NOT NULL CHECK (slot >= 0),
  signature text NOT NULL,
  received_at utc_timestamp NOT NULL,
  commitment text NOT NULL CHECK (commitment = 'confirmed'),
  parser_version integer NOT NULL CHECK (parser_version > 0),
  payload jsonb NOT NULL,
  payload_hash content_hash NOT NULL,
  raw_object_hash content_hash NOT NULL REFERENCES raw_objects(object_hash),
  PRIMARY KEY (provider_id, filter_id, signature)
);

CREATE INDEX raw_filtered_transactions_reconciliation
  ON raw_filtered_transactions (slot, received_at);

CREATE TRIGGER raw_filtered_transactions_immutable
  BEFORE UPDATE OR DELETE ON raw_filtered_transactions
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

CREATE TABLE filtered_transaction_reconciliations (
  provider_id text NOT NULL,
  filter_id text NOT NULL,
  signature text NOT NULL,
  status text NOT NULL CHECK (status IN ('FINALIZED','MISSING','FAILED')),
  reconciled_at utc_timestamp NOT NULL,
  finalized_block_hash text,
  detail text,
  record_hash content_hash NOT NULL UNIQUE,
  PRIMARY KEY (provider_id, filter_id, signature),
  FOREIGN KEY (provider_id, filter_id, signature)
    REFERENCES raw_filtered_transactions(provider_id, filter_id, signature),
  CHECK ((status = 'FINALIZED' AND finalized_block_hash IS NOT NULL) OR status <> 'FINALIZED')
);

CREATE TRIGGER filtered_transaction_reconciliations_immutable
  BEFORE UPDATE OR DELETE ON filtered_transaction_reconciliations
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

CREATE TABLE filtered_stream_checkpoints (
  provider_id text NOT NULL,
  filter_id text NOT NULL,
  highest_received_slot bigint CHECK (highest_received_slot >= 0),
  highest_reconciled_slot bigint CHECK (highest_reconciled_slot >= 0),
  reconnect_count bigint NOT NULL DEFAULT 0 CHECK (reconnect_count >= 0),
  last_connected_at utc_timestamp,
  last_disconnected_at utc_timestamp,
  last_error text,
  updated_at utc_timestamp NOT NULL,
  PRIMARY KEY (provider_id, filter_id),
  CHECK (highest_reconciled_slot IS NULL OR highest_received_slot IS NULL OR
         highest_reconciled_slot <= highest_received_slot)
);

COMMIT;
