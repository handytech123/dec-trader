BEGIN;

CREATE INDEX IF NOT EXISTS capital_events_recent
  ON capital_events (event_time DESC, event_id DESC);

COMMIT;
