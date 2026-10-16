BEGIN;

CREATE TABLE capital_event_forward_outcomes (
  event_id text NOT NULL REFERENCES capital_events(event_id),
  horizon text NOT NULL CHECK (horizon IN ('1m', '5m', '15m', '1h', '6h', '24h')),
  entry_snapshot_id text NOT NULL REFERENCES reference_price_snapshots(snapshot_id),
  exit_snapshot_id text NOT NULL REFERENCES reference_price_snapshots(snapshot_id),
  event_at utc_timestamp NOT NULL,
  target_at utc_timestamp NOT NULL,
  exit_at utc_timestamp NOT NULL,
  entry_price numeric(38, 18) NOT NULL CHECK (entry_price > 0),
  exit_price numeric(38, 18) NOT NULL CHECK (exit_price > 0),
  return_pct numeric(38, 18) NOT NULL,
  maximum_favorable_excursion_pct numeric(38, 18) NOT NULL,
  maximum_adverse_excursion_pct numeric(38, 18) NOT NULL,
  entry_age_ms integer NOT NULL CHECK (entry_age_ms >= 0),
  labeling_version integer NOT NULL CHECK (labeling_version > 0),
  labeled_at utc_timestamp NOT NULL,
  content_hash content_hash NOT NULL UNIQUE,
  PRIMARY KEY (event_id, horizon, labeling_version)
);

CREATE INDEX capital_event_forward_outcomes_horizon
  ON capital_event_forward_outcomes (horizon, exit_at);

CREATE TRIGGER capital_event_forward_outcomes_immutable
  BEFORE UPDATE OR DELETE ON capital_event_forward_outcomes
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
