BEGIN;

CREATE TABLE capital_event_benchmark_outcomes (
  event_id text NOT NULL REFERENCES capital_events(event_id),
  horizon text NOT NULL CHECK (horizon IN ('1m', '5m', '15m', '1h', '6h', '24h')),
  benchmark_instrument_id text NOT NULL,
  entry_event_id text NOT NULL REFERENCES canonical_market_events(event_id),
  exit_event_id text NOT NULL REFERENCES canonical_market_events(event_id),
  event_at utc_timestamp NOT NULL,
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
  PRIMARY KEY (event_id, horizon, benchmark_instrument_id, labeling_version)
);

CREATE INDEX capital_event_benchmark_outcomes_horizon
  ON capital_event_benchmark_outcomes (benchmark_instrument_id, horizon, exit_at);

CREATE TRIGGER capital_event_benchmark_outcomes_immutable
  BEFORE UPDATE OR DELETE ON capital_event_benchmark_outcomes
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
