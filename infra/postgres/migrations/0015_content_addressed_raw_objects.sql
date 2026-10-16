BEGIN;

CREATE TABLE raw_objects (
  object_hash content_hash PRIMARY KEY,
  media_type text NOT NULL,
  encoding text NOT NULL CHECK (encoding = 'GZIP_JSON_V1'),
  payload bytea NOT NULL,
  uncompressed_bytes bigint NOT NULL CHECK (uncompressed_bytes >= 0),
  compressed_bytes bigint NOT NULL CHECK (compressed_bytes >= 0),
  created_at utc_timestamp NOT NULL,
  CHECK (octet_length(payload) = compressed_bytes)
);

ALTER TABLE raw_observations
  ADD COLUMN raw_object_hash content_hash REFERENCES raw_objects(object_hash);
ALTER TABLE raw_chain_blocks
  ADD COLUMN raw_object_hash content_hash REFERENCES raw_objects(object_hash);
ALTER TABLE raw_public_market_messages
  ADD COLUMN raw_object_hash content_hash REFERENCES raw_objects(object_hash);

CREATE INDEX raw_objects_created_at ON raw_objects (created_at, object_hash);

CREATE TRIGGER raw_objects_immutable
  BEFORE UPDATE OR DELETE ON raw_objects
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
