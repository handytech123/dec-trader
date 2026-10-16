BEGIN;

CREATE TABLE entity_activity_rollup_runs (
  run_id text PRIMARY KEY,
  dataset_cutoff utc_timestamp NOT NULL,
  generated_at utc_timestamp NOT NULL,
  algorithm_version integer NOT NULL CHECK (algorithm_version > 0),
  address_count bigint NOT NULL CHECK (address_count >= 0),
  event_count bigint NOT NULL CHECK (event_count >= 0),
  record_hash content_hash NOT NULL UNIQUE
);

CREATE TABLE entity_activity_rollups (
  run_id text NOT NULL,
  address text NOT NULL,
  event_count bigint NOT NULL CHECK (event_count > 0),
  unique_counterparty_count bigint NOT NULL CHECK (unique_counterparty_count >= 0),
  inflow_event_count bigint NOT NULL CHECK (inflow_event_count >= 0),
  outflow_event_count bigint NOT NULL CHECK (outflow_event_count >= 0),
  first_seen_at utc_timestamp NOT NULL,
  last_seen_at utc_timestamp NOT NULL,
  PRIMARY KEY (run_id, address),
  CHECK (inflow_event_count + outflow_event_count = event_count),
  CHECK (first_seen_at <= last_seen_at)
);

CREATE INDEX entity_activity_rollups_rank
  ON entity_activity_rollups (run_id, event_count DESC, address);

CREATE TRIGGER entity_activity_rollup_runs_immutable
  BEFORE UPDATE OR DELETE ON entity_activity_rollup_runs
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

CREATE TRIGGER entity_activity_rollups_immutable
  BEFORE UPDATE OR DELETE ON entity_activity_rollups
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
