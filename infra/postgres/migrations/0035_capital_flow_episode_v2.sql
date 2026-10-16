BEGIN;

ALTER TABLE capital_flow_episodes
  DROP CONSTRAINT IF EXISTS capital_flow_episodes_asset_id_window_start_algorithm_version_key;

ALTER TABLE capital_flow_episodes
  ADD COLUMN config_hash content_hash NOT NULL
    DEFAULT 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  ADD COLUMN source_entity_id text REFERENCES entities(entity_id),
  ADD COLUMN destination_entity_id text REFERENCES entities(entity_id),
  ADD COLUMN direction text NOT NULL DEFAULT 'UNKNOWN→UNKNOWN',
  ADD COLUMN attribution_as_of utc_timestamp,
  ADD COLUMN attribution_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN quality text NOT NULL DEFAULT 'LEGACY_V1'
    CHECK (quality IN ('LEGACY_V1','VERIFIED_CONTEXT','ATTRIBUTED','UNKNOWN_CONTEXT'));

ALTER TABLE capital_flow_episodes ALTER COLUMN config_hash DROP DEFAULT;
ALTER TABLE capital_flow_episodes ALTER COLUMN direction DROP DEFAULT;
ALTER TABLE capital_flow_episodes ALTER COLUMN attribution_evidence DROP DEFAULT;
ALTER TABLE capital_flow_episodes ALTER COLUMN quality DROP DEFAULT;

CREATE INDEX capital_flow_episodes_version_time
  ON capital_flow_episodes (algorithm_version, window_start DESC, episode_id);

CREATE TABLE capital_flow_episode_algorithms (
  algorithm_version integer PRIMARY KEY CHECK (algorithm_version > 0),
  configuration jsonb NOT NULL,
  config_hash content_hash NOT NULL UNIQUE,
  registered_at utc_timestamp NOT NULL,
  code_revision text NOT NULL,
  description text NOT NULL
);

CREATE TRIGGER capital_flow_episode_algorithms_immutable
  BEFORE UPDATE OR DELETE ON capital_flow_episode_algorithms
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
