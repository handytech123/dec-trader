BEGIN;

CREATE TABLE research_quality_manifests (
  manifest_id text PRIMARY KEY,
  period_start utc_timestamp NOT NULL,
  period_end utc_timestamp NOT NULL,
  generated_at utc_timestamp NOT NULL,
  manifest jsonb NOT NULL,
  code_hash content_hash NOT NULL,
  content_hash content_hash NOT NULL UNIQUE,
  CHECK (period_start < period_end)
);

CREATE TABLE research_hypothesis_attempts (
  attempt_id text PRIMARY KEY,
  protocol_id text REFERENCES research_protocols(protocol_id),
  family text NOT NULL,
  family_version integer NOT NULL CHECK (family_version > 0),
  tier text NOT NULL CHECK (tier IN ('EXPLORATORY','CONFIRMATORY')),
  definition jsonb NOT NULL,
  definition_hash content_hash NOT NULL,
  registered_at utc_timestamp NOT NULL,
  status text NOT NULL CHECK (status IN ('REGISTERED','TESTED','REJECTED','PROMOTION_ELIGIBLE')),
  code_hash content_hash NOT NULL,
  config_hash content_hash NOT NULL,
  content_hash content_hash NOT NULL UNIQUE,
  UNIQUE (family, family_version, definition_hash)
);

CREATE TABLE negative_knowledge_registry (
  rejection_id text PRIMARY KEY,
  attempt_id text NOT NULL REFERENCES research_hypothesis_attempts(attempt_id),
  rejected_at utc_timestamp NOT NULL,
  observation_period_start utc_timestamp NOT NULL,
  observation_period_end utc_timestamp NOT NULL,
  reason_code text NOT NULL,
  statistical_result jsonb NOT NULL,
  economic_result jsonb NOT NULL,
  code_hash content_hash NOT NULL,
  config_hash content_hash NOT NULL,
  content_hash content_hash NOT NULL UNIQUE,
  UNIQUE (attempt_id),
  CHECK (observation_period_start < observation_period_end)
);

CREATE TABLE research_promotion_records (
  promotion_id text PRIMARY KEY,
  attempt_id text NOT NULL REFERENCES research_hypothesis_attempts(attempt_id),
  protocol_id text NOT NULL REFERENCES research_protocols(protocol_id),
  development_run_id text NOT NULL REFERENCES research_analysis_runs(run_id),
  created_at utc_timestamp NOT NULL,
  decision text NOT NULL CHECK (decision IN ('REJECTED','APPROVED_FOR_ONE_SHOT_HOLDOUT')),
  gate_result jsonb NOT NULL,
  future_holdout_start utc_timestamp NOT NULL,
  future_holdout_end utc_timestamp NOT NULL,
  content_hash content_hash NOT NULL UNIQUE,
  UNIQUE (attempt_id),
  UNIQUE (protocol_id, future_holdout_start, future_holdout_end),
  CHECK (future_holdout_start < future_holdout_end)
);

ALTER TABLE research_analysis_runs
  ADD COLUMN quality_manifest_id text REFERENCES research_quality_manifests(manifest_id);

CREATE TRIGGER research_quality_manifests_immutable
  BEFORE UPDATE OR DELETE ON research_quality_manifests
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();
CREATE TRIGGER research_hypothesis_attempts_immutable
  BEFORE UPDATE OR DELETE ON research_hypothesis_attempts
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();
CREATE TRIGGER negative_knowledge_registry_immutable
  BEFORE UPDATE OR DELETE ON negative_knowledge_registry
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();
CREATE TRIGGER research_promotion_records_immutable
  BEFORE UPDATE OR DELETE ON research_promotion_records
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
