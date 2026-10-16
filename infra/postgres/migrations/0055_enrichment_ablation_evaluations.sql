BEGIN;

CREATE TABLE enrichment_ablation_evaluations (
  evaluation_id text PRIMARY KEY,
  ablation_id text NOT NULL REFERENCES enrichment_ablation_manifests(ablation_id),
  generated_at utc_timestamp NOT NULL,
  dataset_cutoff utc_timestamp NOT NULL,
  evaluation_version integer NOT NULL CHECK (evaluation_version > 0),
  observation_count integer NOT NULL CHECK (observation_count > 0),
  event_time_cluster_count integer NOT NULL CHECK (event_time_cluster_count > 0),
  result jsonb NOT NULL,
  code_hash content_hash NOT NULL,
  holdout_accessed boolean NOT NULL DEFAULT false CHECK (holdout_accessed = false),
  content_hash content_hash NOT NULL UNIQUE,
  UNIQUE (ablation_id, evaluation_version, code_hash)
);

CREATE INDEX enrichment_ablation_evaluations_created
  ON enrichment_ablation_evaluations (generated_at DESC, evaluation_id DESC);

CREATE TRIGGER enrichment_ablation_evaluations_immutable
  BEFORE UPDATE OR DELETE ON enrichment_ablation_evaluations
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
