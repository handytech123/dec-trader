BEGIN;

CREATE TABLE holdout_access_audit (
  audit_id text PRIMARY KEY,
  protocol_id text NOT NULL REFERENCES research_protocols(protocol_id),
  run_id text NOT NULL REFERENCES research_analysis_runs(run_id),
  accessed_at utc_timestamp NOT NULL,
  dataset_hash content_hash NOT NULL,
  code_revision text NOT NULL,
  protocol_version integer NOT NULL CHECK (protocol_version > 0),
  promotion_evidence_hash content_hash NOT NULL,
  result_hash content_hash NOT NULL,
  content_hash content_hash NOT NULL UNIQUE,
  UNIQUE (protocol_id, run_id)
);

CREATE TRIGGER holdout_access_audit_immutable
  BEFORE UPDATE OR DELETE ON holdout_access_audit
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
