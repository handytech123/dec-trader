BEGIN;

ALTER TABLE chain_collection_gaps
  DROP CONSTRAINT chain_collection_gaps_reason_check;

ALTER TABLE chain_collection_gaps
  ADD CONSTRAINT chain_collection_gaps_reason_check
  CHECK (reason IN ('SKIPPED_OR_UNAVAILABLE', 'LIVE_TAIL_FAST_FORWARD'));

COMMIT;
