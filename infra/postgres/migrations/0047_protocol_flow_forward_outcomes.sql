BEGIN;

CREATE TABLE protocol_flow_forward_outcomes (
  feature_id text NOT NULL REFERENCES protocol_flow_windows(feature_id),
  horizon text NOT NULL CHECK (horizon IN ('1m', '5m', '15m', '1h', '6h', '24h')),
  entry_snapshot_id text NOT NULL REFERENCES reference_price_snapshots(snapshot_id),
  exit_snapshot_id text NOT NULL REFERENCES reference_price_snapshots(snapshot_id),
  observation_at utc_timestamp NOT NULL,
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
  PRIMARY KEY (feature_id, horizon, labeling_version),
  CHECK (observation_at < target_at),
  CHECK (target_at <= exit_at)
);

CREATE INDEX protocol_flow_forward_outcomes_research
  ON protocol_flow_forward_outcomes (horizon, observation_at, exit_at);

CREATE TRIGGER protocol_flow_forward_outcomes_immutable
  BEFORE UPDATE OR DELETE ON protocol_flow_forward_outcomes
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
