BEGIN;

CREATE INDEX IF NOT EXISTS capital_events_transaction_hash
  ON capital_events (transaction_hash)
  WHERE transaction_hash IS NOT NULL;

COMMIT;
