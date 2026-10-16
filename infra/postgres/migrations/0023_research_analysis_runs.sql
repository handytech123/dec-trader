BEGIN;

CREATE TABLE research_analysis_runs (
  run_id text PRIMARY KEY,
  protocol_id text NOT NULL REFERENCES research_protocols(protocol_id),
  analysis_family text NOT NULL CHECK (analysis_family IN ('TRANSFER_MAGNITUDE')),
  analysis_version integer NOT NULL CHECK (analysis_version > 0),
  generated_at utc_timestamp NOT NULL,
  status text NOT NULL CHECK (status IN ('COMPLETE', 'INSUFFICIENT_DATA')),
  observation_count bigint NOT NULL CHECK (observation_count >= 0),
  result jsonb NOT NULL,
  code_hash content_hash NOT NULL,
  content_hash content_hash NOT NULL UNIQUE,
  UNIQUE (protocol_id, analysis_family, analysis_version, code_hash)
);

CREATE INDEX research_analysis_runs_protocol
  ON research_analysis_runs (protocol_id, generated_at DESC);

CREATE TRIGGER research_analysis_runs_immutable
  BEFORE UPDATE OR DELETE ON research_analysis_runs
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
