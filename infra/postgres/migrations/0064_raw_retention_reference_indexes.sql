BEGIN;

CREATE INDEX raw_filtered_transactions_raw_object
  ON raw_filtered_transactions (raw_object_hash);

CREATE INDEX entity_source_snapshots_raw_object
  ON entity_source_snapshots (raw_object_hash);

CREATE INDEX capital_event_owner_corrections_raw_object
  ON capital_event_owner_corrections (raw_object_hash);

CREATE INDEX filtered_transaction_normalizations_raw_block
  ON filtered_transaction_normalizations (raw_block_hash);

COMMIT;
