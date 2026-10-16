BEGIN;

ALTER TABLE capital_flow_episodes
  DROP CONSTRAINT IF EXISTS capital_flow_episodes_asset_id_window_start_algorithm_version_key;

ALTER TABLE capital_flow_episodes
  DROP CONSTRAINT IF EXISTS capital_flow_episodes_asset_id_window_start_algorithm_versi_key;

COMMIT;
