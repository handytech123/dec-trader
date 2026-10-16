BEGIN;

CREATE TABLE protocol_flow_windows (
  feature_id text PRIMARY KEY,
  protocol_key text NOT NULL,
  window_start utc_timestamp NOT NULL,
  window_end utc_timestamp NOT NULL,
  anchor_event_id text NOT NULL REFERENCES capital_events(event_id),
  event_count bigint NOT NULL CHECK (event_count > 0),
  distinct_counterparty_count bigint NOT NULL CHECK (distinct_counterparty_count >= 0),
  native_sol_quantity numeric NOT NULL CHECK (native_sol_quantity >= 0),
  wrapped_sol_quantity numeric NOT NULL CHECK (wrapped_sol_quantity >= 0),
  prior_window_count bigint NOT NULL CHECK (prior_window_count >= 0),
  prior_mean_event_count numeric,
  prior_stddev_event_count numeric,
  event_count_zscore numeric,
  evidence_event_ids jsonb NOT NULL,
  generated_at utc_timestamp NOT NULL,
  algorithm_version integer NOT NULL CHECK (algorithm_version > 0),
  record_hash content_hash NOT NULL UNIQUE,
  UNIQUE (protocol_key, window_start, algorithm_version),
  CHECK (window_start < window_end),
  CHECK (jsonb_typeof(evidence_event_ids) = 'array')
);

CREATE INDEX protocol_flow_windows_research
  ON protocol_flow_windows (protocol_key, window_start, algorithm_version);

CREATE TRIGGER protocol_flow_windows_immutable
  BEFORE UPDATE OR DELETE ON protocol_flow_windows
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
