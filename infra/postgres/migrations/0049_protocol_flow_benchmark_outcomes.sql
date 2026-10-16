BEGIN;

CREATE TABLE protocol_flow_benchmark_outcomes (
  feature_id text NOT NULL REFERENCES protocol_flow_windows(feature_id),
  horizon text NOT NULL CHECK (horizon IN ('1m', '5m', '15m', '1h', '6h', '24h')),
  benchmark_instrument_id text NOT NULL,
  entry_event_id text NOT NULL REFERENCES canonical_market_events(event_id),
  exit_event_id text NOT NULL REFERENCES canonical_market_events(event_id),
  observation_at utc_timestamp NOT NULL,
  target_at utc_timestamp NOT NULL,
  exit_at utc_timestamp NOT NULL,
  benchmark_entry_price numeric(38, 18) NOT NULL CHECK (benchmark_entry_price > 0),
  benchmark_exit_price numeric(38, 18) NOT NULL CHECK (benchmark_exit_price > 0),
  benchmark_return_pct numeric(38, 18) NOT NULL,
  sol_return_pct numeric(38, 18) NOT NULL,
  excess_return_pct numeric(38, 18) NOT NULL,
  labeling_version integer NOT NULL CHECK (labeling_version > 0),
  labeled_at utc_timestamp NOT NULL,
  content_hash content_hash NOT NULL UNIQUE,
  PRIMARY KEY (feature_id, horizon, benchmark_instrument_id, labeling_version)
);

CREATE INDEX protocol_flow_benchmark_outcomes_research
  ON protocol_flow_benchmark_outcomes (benchmark_instrument_id, horizon, observation_at, exit_at);

CREATE TRIGGER protocol_flow_benchmark_outcomes_immutable
  BEFORE UPDATE OR DELETE ON protocol_flow_benchmark_outcomes
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
