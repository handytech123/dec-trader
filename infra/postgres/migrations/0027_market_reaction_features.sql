BEGIN;

CREATE TABLE capital_event_market_reactions (
  feature_id text PRIMARY KEY,
  capital_event_id text NOT NULL REFERENCES capital_events(event_id),
  venue text NOT NULL,
  instrument_id text NOT NULL,
  window_seconds integer NOT NULL CHECK (window_seconds > 0),
  window_start utc_timestamp NOT NULL,
  window_end utc_timestamp NOT NULL,
  before_snapshot_hash content_hash NOT NULL,
  after_snapshot_hash content_hash NOT NULL,
  algorithm_version integer NOT NULL CHECK (algorithm_version > 0),
  features jsonb NOT NULL,
  content_hash content_hash NOT NULL UNIQUE,
  UNIQUE (capital_event_id, venue, instrument_id, window_seconds, algorithm_version),
  CHECK (window_start < window_end)
);

CREATE INDEX capital_event_market_reactions_event
  ON capital_event_market_reactions (capital_event_id, window_seconds);

CREATE TRIGGER capital_event_market_reactions_immutable
  BEFORE UPDATE OR DELETE ON capital_event_market_reactions
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
