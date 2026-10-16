BEGIN;

CREATE TABLE nansen_change_features (
  feature_id text PRIMARY KEY,
  subject text NOT NULL,
  symbol text NOT NULL,
  previous_retrieved_at utc_timestamp NOT NULL,
  current_retrieved_at utc_timestamp NOT NULL,
  feature jsonb NOT NULL,
  source_observation_ids jsonb NOT NULL,
  point_in_time_eligible boolean NOT NULL CHECK (point_in_time_eligible),
  parser_version integer NOT NULL CHECK (parser_version > 0),
  content_hash content_hash NOT NULL UNIQUE,
  CHECK (previous_retrieved_at < current_retrieved_at),
  UNIQUE (subject, previous_retrieved_at, current_retrieved_at, parser_version)
);

CREATE INDEX nansen_change_features_point_in_time
  ON nansen_change_features (current_retrieved_at DESC, subject);

CREATE TRIGGER nansen_change_features_immutable
  BEFORE UPDATE OR DELETE ON nansen_change_features
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
