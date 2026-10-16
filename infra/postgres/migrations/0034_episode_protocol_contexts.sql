BEGIN;

CREATE TABLE capital_flow_episode_protocol_contexts (
  episode_id text NOT NULL REFERENCES capital_flow_episodes(episode_id),
  algorithm_version integer NOT NULL CHECK (algorithm_version > 0),
  verified_event_count integer NOT NULL CHECK (verified_event_count >= 0),
  primary_venue_label text,
  primary_venue_entity_type text,
  venue_counts jsonb NOT NULL,
  computed_at utc_timestamp NOT NULL,
  content_hash content_hash NOT NULL UNIQUE,
  PRIMARY KEY (episode_id, algorithm_version)
);

CREATE TRIGGER capital_flow_episode_protocol_contexts_immutable
  BEFORE UPDATE OR DELETE ON capital_flow_episode_protocol_contexts
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
