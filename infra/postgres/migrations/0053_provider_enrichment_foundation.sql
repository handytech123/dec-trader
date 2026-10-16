BEGIN;

CREATE TABLE provider_capability_manifests (
  manifest_id text PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('nansen','coinglass')),
  api_version text NOT NULL,
  probed_at utc_timestamp NOT NULL,
  capabilities jsonb NOT NULL,
  rate_metadata jsonb NOT NULL,
  parser_version integer NOT NULL CHECK (parser_version > 0),
  content_hash content_hash NOT NULL UNIQUE
);

CREATE TABLE provider_usage_metrics (
  usage_id text PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('nansen','coinglass')),
  capability text NOT NULL,
  observed_at utc_timestamp NOT NULL,
  request_count integer NOT NULL CHECK (request_count >= 0),
  cache_hit_count integer NOT NULL CHECK (cache_hit_count >= 0),
  coalesced_count integer NOT NULL CHECK (coalesced_count >= 0),
  restricted_count integer NOT NULL CHECK (restricted_count >= 0),
  error_count integer NOT NULL CHECK (error_count >= 0),
  credits_used numeric CHECK (credits_used IS NULL OR credits_used >= 0),
  rate_metadata jsonb NOT NULL,
  content_hash content_hash NOT NULL UNIQUE
);

CREATE TABLE raw_enrichment_observations (
  raw_enrichment_id text PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('nansen','coinglass')),
  capability text NOT NULL,
  request_hash content_hash NOT NULL,
  response_hash content_hash NOT NULL,
  requested_at utc_timestamp NOT NULL,
  retrieved_at utc_timestamp NOT NULL,
  request_metadata jsonb NOT NULL,
  response_payload jsonb,
  retention_basis text NOT NULL CHECK (retention_basis IN ('FULL_RESPONSE','HASH_AND_METADATA')),
  parser_version integer NOT NULL CHECK (parser_version > 0),
  content_hash content_hash NOT NULL UNIQUE,
  UNIQUE (provider, capability, request_hash, response_hash)
);

CREATE TABLE canonical_enrichment_observations (
  observation_id text PRIMARY KEY,
  raw_enrichment_id text NOT NULL REFERENCES raw_enrichment_observations(raw_enrichment_id),
  provider text NOT NULL CHECK (provider IN ('nansen','coinglass')),
  observation_type text NOT NULL,
  subject text NOT NULL,
  chain text,
  scope text NOT NULL,
  metric text NOT NULL,
  value jsonb NOT NULL,
  unit text,
  event_at utc_timestamp,
  as_of utc_timestamp,
  retrieved_at utc_timestamp NOT NULL,
  point_in_time_eligible boolean NOT NULL,
  retrospective_only boolean NOT NULL,
  freshness_seconds integer CHECK (freshness_seconds IS NULL OR freshness_seconds >= 0),
  quality text NOT NULL CHECK (quality IN ('VALID','STALE','RESTRICTED','MALFORMED')),
  parser_version integer NOT NULL CHECK (parser_version > 0),
  content_hash content_hash NOT NULL UNIQUE,
  CHECK (NOT (point_in_time_eligible AND retrospective_only))
);

CREATE INDEX canonical_enrichment_point_in_time
  ON canonical_enrichment_observations (provider, observation_type, retrieved_at, observation_id)
  WHERE point_in_time_eligible AND quality = 'VALID';

CREATE TABLE provider_enrichment_incidents (
  incident_id text PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('nansen','coinglass')),
  capability text NOT NULL,
  detected_at utc_timestamp NOT NULL,
  incident_type text NOT NULL,
  retry_after_seconds integer CHECK (retry_after_seconds IS NULL OR retry_after_seconds >= 0),
  details jsonb NOT NULL,
  content_hash content_hash NOT NULL UNIQUE
);

CREATE TABLE enrichment_ablation_manifests (
  ablation_id text PRIMARY KEY,
  created_at utc_timestamp NOT NULL,
  dataset_cutoff utc_timestamp NOT NULL,
  variants jsonb NOT NULL,
  base_population_hash content_hash NOT NULL,
  outcome_definition_hash content_hash NOT NULL,
  policy_hash content_hash NOT NULL,
  holdout_accessed boolean NOT NULL DEFAULT false CHECK (holdout_accessed = false),
  content_hash content_hash NOT NULL UNIQUE
);

CREATE TRIGGER provider_capability_manifests_immutable
  BEFORE UPDATE OR DELETE ON provider_capability_manifests
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();
CREATE TRIGGER provider_usage_metrics_immutable
  BEFORE UPDATE OR DELETE ON provider_usage_metrics
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();
CREATE TRIGGER raw_enrichment_observations_immutable
  BEFORE UPDATE OR DELETE ON raw_enrichment_observations
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();
CREATE TRIGGER canonical_enrichment_observations_immutable
  BEFORE UPDATE OR DELETE ON canonical_enrichment_observations
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();
CREATE TRIGGER provider_enrichment_incidents_immutable
  BEFORE UPDATE OR DELETE ON provider_enrichment_incidents
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();
CREATE TRIGGER enrichment_ablation_manifests_immutable
  BEFORE UPDATE OR DELETE ON enrichment_ablation_manifests
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
