BEGIN;

CREATE DOMAIN utc_timestamp AS timestamptz;
CREATE DOMAIN content_hash AS text CHECK (VALUE ~ '^sha256:[0-9a-f]{64}$');
CREATE DOMAIN atomic_quantity AS numeric(78, 0) CHECK (VALUE >= 0);

CREATE TABLE assets (
  asset_id text PRIMARY KEY,
  chain text NOT NULL CHECK (chain = 'solana'),
  mint text NOT NULL UNIQUE,
  token_program text NOT NULL,
  decimals smallint NOT NULL CHECK (decimals BETWEEN 0 AND 18),
  metadata_status text NOT NULL,
  first_observed_at utc_timestamp NOT NULL
);

CREATE TABLE raw_observations (
  observation_id text PRIMARY KEY,
  ingestion_id text NOT NULL,
  source text NOT NULL,
  source_id text NOT NULL,
  observed_at utc_timestamp NOT NULL,
  source_time utc_timestamp NOT NULL,
  slot numeric(20, 0),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  payload jsonb NOT NULL,
  payload_hash content_hash NOT NULL,
  record_hash content_hash NOT NULL UNIQUE,
  UNIQUE (source, source_id, payload_hash)
);

CREATE INDEX raw_observations_point_in_time
  ON raw_observations (source_time, slot, source, source_id);

CREATE TABLE market_observations (
  observation_id text PRIMARY KEY,
  raw_observation_hash content_hash NOT NULL REFERENCES raw_observations(record_hash),
  asset_id text NOT NULL REFERENCES assets(asset_id),
  pool_id text,
  price numeric(38, 18) NOT NULL CHECK (price >= 0),
  volume numeric(38, 18) NOT NULL CHECK (volume >= 0),
  liquidity numeric(38, 18) NOT NULL CHECK (liquidity >= 0),
  observed_at utc_timestamp NOT NULL,
  source_time utc_timestamp NOT NULL,
  slot numeric(20, 0),
  source text NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  record_hash content_hash NOT NULL UNIQUE
);

CREATE INDEX market_observations_point_in_time
  ON market_observations (asset_id, source_time, slot);

CREATE TABLE feature_definitions (
  feature_definition_id text PRIMARY KEY,
  name text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  units text NOT NULL,
  window_spec text NOT NULL,
  sources jsonb NOT NULL,
  null_behavior text NOT NULL CHECK (null_behavior IN ('REJECT', 'NULL', 'ZERO')),
  freshness_limit_seconds integer NOT NULL CHECK (freshness_limit_seconds > 0),
  code_hash content_hash NOT NULL,
  config_hash content_hash NOT NULL,
  content_hash content_hash NOT NULL UNIQUE,
  published_at utc_timestamp NOT NULL,
  UNIQUE (name, version)
);

CREATE TABLE feature_snapshots (
  feature_snapshot_id text PRIMARY KEY,
  as_of utc_timestamp NOT NULL,
  as_of_slot numeric(20, 0),
  definition_hashes jsonb NOT NULL,
  observation_hashes jsonb NOT NULL,
  values jsonb NOT NULL,
  content_hash content_hash NOT NULL UNIQUE,
  published_at utc_timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE strategy_definitions (
  strategy_definition_id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  owner_id text NOT NULL,
  created_at utc_timestamp NOT NULL
);

CREATE TABLE strategy_versions (
  strategy_version_id text PRIMARY KEY,
  strategy_definition_id text NOT NULL REFERENCES strategy_definitions(strategy_definition_id),
  version integer NOT NULL CHECK (version > 0),
  source_hash content_hash NOT NULL,
  config_hash content_hash NOT NULL,
  feature_schema_hash content_hash NOT NULL,
  model_artifact_hash content_hash,
  content_hash content_hash NOT NULL UNIQUE,
  eligibility text NOT NULL CHECK (eligibility IN ('INACTIVE', 'RESEARCH', 'SUSPENDED')),
  published_at utc_timestamp NOT NULL,
  UNIQUE (strategy_definition_id, version)
);

CREATE TABLE experiments (
  experiment_id text PRIMARY KEY,
  hypothesis text NOT NULL,
  strategy_version_id text NOT NULL REFERENCES strategy_versions(strategy_version_id),
  dataset_start utc_timestamp NOT NULL,
  dataset_end utc_timestamp NOT NULL,
  mode text NOT NULL CHECK (mode = 'BACKTEST'),
  seed numeric(78, 0) NOT NULL CHECK (seed >= 0),
  status text NOT NULL CHECK (status IN ('REGISTERED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  content_hash content_hash NOT NULL UNIQUE,
  registered_at utc_timestamp NOT NULL,
  CHECK (dataset_start < dataset_end)
);

CREATE TABLE evaluations (
  evaluation_id text PRIMARY KEY,
  experiment_id text NOT NULL REFERENCES experiments(experiment_id),
  strategy_version_id text NOT NULL REFERENCES strategy_versions(strategy_version_id),
  feature_snapshot_id text NOT NULL REFERENCES feature_snapshots(feature_snapshot_id),
  input_hash content_hash NOT NULL,
  proposal_hash content_hash NOT NULL,
  replay_hash content_hash NOT NULL,
  started_at utc_timestamp NOT NULL,
  completed_at utc_timestamp,
  error jsonb,
  UNIQUE (experiment_id, input_hash, replay_hash)
);

CREATE TABLE trade_proposals (
  proposal_id text PRIMARY KEY,
  evaluation_id text NOT NULL REFERENCES evaluations(evaluation_id),
  strategy_version_id text NOT NULL REFERENCES strategy_versions(strategy_version_id),
  experiment_id text NOT NULL REFERENCES experiments(experiment_id),
  proposal jsonb NOT NULL,
  proposal_hash content_hash NOT NULL UNIQUE,
  created_at utc_timestamp NOT NULL
);

CREATE FUNCTION reject_published_record_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'published research records are immutable; append a new version';
END;
$$;

CREATE TRIGGER feature_definitions_immutable
  BEFORE UPDATE OR DELETE ON feature_definitions
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();
CREATE TRIGGER feature_snapshots_immutable
  BEFORE UPDATE OR DELETE ON feature_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();
CREATE TRIGGER strategy_versions_immutable
  BEFORE UPDATE OR DELETE ON strategy_versions
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();
CREATE TRIGGER evaluations_immutable
  BEFORE UPDATE OR DELETE ON evaluations
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();
CREATE TRIGGER trade_proposals_immutable
  BEFORE UPDATE OR DELETE ON trade_proposals
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
