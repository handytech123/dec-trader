BEGIN;

CREATE INDEX raw_observations_raw_object
  ON raw_observations (raw_object_hash);

CREATE INDEX raw_chain_blocks_raw_object
  ON raw_chain_blocks (raw_object_hash);

CREATE INDEX raw_public_market_messages_raw_object
  ON raw_public_market_messages (raw_object_hash);

COMMIT;
