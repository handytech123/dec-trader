BEGIN;

CREATE TABLE research_protocols (
  protocol_id text PRIMARY KEY,
  name text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  objective text NOT NULL,
  dataset_cutoff utc_timestamp NOT NULL,
  frozen_at utc_timestamp NOT NULL,
  protocol jsonb NOT NULL,
  code_hash content_hash NOT NULL,
  content_hash content_hash NOT NULL UNIQUE
);

CREATE UNIQUE INDEX research_protocol_name_version
  ON research_protocols (name, version);

CREATE TRIGGER research_protocols_immutable
  BEFORE UPDATE OR DELETE ON research_protocols
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
