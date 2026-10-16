BEGIN;

CREATE TABLE chain_collection_checkpoints (
  provider_id text NOT NULL,
  chain text NOT NULL,
  last_finalized_slot numeric(20, 0) NOT NULL CHECK (last_finalized_slot >= 0),
  updated_at utc_timestamp NOT NULL,
  PRIMARY KEY (provider_id, chain)
);

CREATE TABLE chain_collection_gaps (
  provider_id text NOT NULL,
  chain text NOT NULL,
  start_slot numeric(20, 0) NOT NULL CHECK (start_slot >= 0),
  end_slot numeric(20, 0) NOT NULL CHECK (end_slot >= start_slot),
  detected_at utc_timestamp NOT NULL,
  reason text NOT NULL CHECK (reason = 'SKIPPED_OR_UNAVAILABLE'),
  PRIMARY KEY (provider_id, chain, start_slot, end_slot)
);

CREATE TABLE raw_chain_blocks (
  provider_id text NOT NULL,
  chain text NOT NULL,
  slot numeric(20, 0) NOT NULL CHECK (slot >= 0),
  provider_ref text NOT NULL,
  source_time utc_timestamp NOT NULL,
  ingested_at utc_timestamp NOT NULL,
  payload jsonb NOT NULL,
  payload_hash content_hash NOT NULL,
  PRIMARY KEY (provider_id, chain, slot),
  UNIQUE (provider_ref, payload_hash)
);

CREATE TRIGGER raw_chain_blocks_immutable
  BEFORE UPDATE OR DELETE ON raw_chain_blocks
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
