BEGIN;

CREATE TABLE raw_retention_runs (
  retention_run_id text PRIMARY KEY,
  cutoff_at utc_timestamp NOT NULL,
  executed_at utc_timestamp NOT NULL,
  maximum_objects integer NOT NULL CHECK (maximum_objects BETWEEN 1 AND 10000),
  objects_deleted integer NOT NULL CHECK (objects_deleted >= 0),
  compressed_bytes_deleted bigint NOT NULL CHECK (compressed_bytes_deleted >= 0),
  chain_blocks_deleted integer NOT NULL CHECK (chain_blocks_deleted >= 0),
  market_messages_deleted integer NOT NULL CHECK (market_messages_deleted >= 0),
  normalization_jobs_deleted integer NOT NULL CHECK (normalization_jobs_deleted >= 0),
  raw_observation_links_cleared integer NOT NULL CHECK (raw_observation_links_cleared >= 0)
);

CREATE TRIGGER raw_retention_runs_immutable
  BEFORE UPDATE OR DELETE ON raw_retention_runs
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

CREATE FUNCTION guard_raw_retention_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('cfie.retention_prune', true) = 'enabled' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'raw records are immutable outside the controlled retention transaction';
END;
$$;

DROP TRIGGER raw_chain_blocks_immutable ON raw_chain_blocks;
CREATE TRIGGER raw_chain_blocks_immutable
  BEFORE UPDATE OR DELETE ON raw_chain_blocks
  FOR EACH ROW EXECUTE FUNCTION guard_raw_retention_mutation();

DROP TRIGGER raw_public_market_messages_immutable ON raw_public_market_messages;
CREATE TRIGGER raw_public_market_messages_immutable
  BEFORE UPDATE OR DELETE ON raw_public_market_messages
  FOR EACH ROW EXECUTE FUNCTION guard_raw_retention_mutation();

DROP TRIGGER raw_objects_immutable ON raw_objects;
CREATE TRIGGER raw_objects_immutable
  BEFORE UPDATE OR DELETE ON raw_objects
  FOR EACH ROW EXECUTE FUNCTION guard_raw_retention_mutation();

COMMIT;
