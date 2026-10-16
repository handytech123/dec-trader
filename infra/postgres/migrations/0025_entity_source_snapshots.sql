BEGIN;

CREATE TABLE entity_source_snapshots (
  source_id text NOT NULL,
  source_url text NOT NULL,
  retrieved_at utc_timestamp NOT NULL,
  evidence_hash content_hash NOT NULL,
  raw_object_hash content_hash NOT NULL REFERENCES raw_objects(object_hash),
  byte_count bigint NOT NULL CHECK (byte_count >= 0),
  record_hash content_hash NOT NULL UNIQUE,
  PRIMARY KEY (source_id, evidence_hash)
);

CREATE INDEX entity_source_snapshots_retrieved
  ON entity_source_snapshots (source_id, retrieved_at DESC);

CREATE TRIGGER entity_source_snapshots_immutable
  BEFORE UPDATE OR DELETE ON entity_source_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
