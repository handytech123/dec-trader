BEGIN;

CREATE TABLE capital_flow_episodes (
  episode_id text PRIMARY KEY,
  asset_id text NOT NULL REFERENCES assets(asset_id),
  window_start utc_timestamp NOT NULL,
  window_end utc_timestamp NOT NULL CHECK (window_end > window_start),
  anchor_event_id text NOT NULL REFERENCES capital_events(event_id),
  event_count integer NOT NULL CHECK (event_count > 0),
  total_quantity numeric(38, 18) NOT NULL CHECK (total_quantity >= 0),
  maximum_quantity numeric(38, 18) NOT NULL CHECK (maximum_quantity >= 0),
  dominant_cohort text NOT NULL,
  cohort_quantities jsonb NOT NULL,
  from_entity_types jsonb NOT NULL,
  to_entity_types jsonb NOT NULL,
  venue_labels jsonb NOT NULL,
  finalized_at utc_timestamp NOT NULL,
  algorithm_version integer NOT NULL CHECK (algorithm_version > 0),
  content_hash content_hash NOT NULL UNIQUE,
  UNIQUE (asset_id, window_start, algorithm_version)
);

CREATE TABLE capital_flow_episode_events (
  episode_id text NOT NULL REFERENCES capital_flow_episodes(episode_id),
  event_id text NOT NULL REFERENCES capital_events(event_id),
  event_ordinal integer NOT NULL CHECK (event_ordinal >= 0),
  PRIMARY KEY (episode_id, event_id),
  UNIQUE (episode_id, event_ordinal)
);

CREATE INDEX capital_flow_episodes_time
  ON capital_flow_episodes (window_start DESC, episode_id);

CREATE TRIGGER capital_flow_episodes_immutable
  BEFORE UPDATE OR DELETE ON capital_flow_episodes
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

CREATE TRIGGER capital_flow_episode_events_immutable
  BEFORE UPDATE OR DELETE ON capital_flow_episode_events
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
