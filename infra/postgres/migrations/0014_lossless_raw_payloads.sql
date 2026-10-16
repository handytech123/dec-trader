BEGIN;

ALTER TABLE raw_observations ADD COLUMN payload_base64 text;
ALTER TABLE raw_chain_blocks ADD COLUMN payload_base64 text;
ALTER TABLE raw_public_market_messages ADD COLUMN payload_base64 text;

COMMIT;
