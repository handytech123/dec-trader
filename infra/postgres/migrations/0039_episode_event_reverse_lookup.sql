BEGIN;

CREATE INDEX capital_flow_episode_events_event_lookup
  ON capital_flow_episode_events (event_id, episode_id);

COMMIT;
