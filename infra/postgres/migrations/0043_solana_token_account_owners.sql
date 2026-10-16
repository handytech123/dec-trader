BEGIN;

CREATE TABLE solana_token_account_owner_observations (
  token_account_address text NOT NULL,
  owner_address text NOT NULL,
  mint text NOT NULL,
  observed_at utc_timestamp NOT NULL,
  raw_object_hash content_hash NOT NULL REFERENCES raw_objects(object_hash),
  record_hash content_hash NOT NULL UNIQUE,
  PRIMARY KEY (raw_object_hash, token_account_address, owner_address, mint)
);

CREATE INDEX solana_token_account_owner_lookup
  ON solana_token_account_owner_observations
  (raw_object_hash, token_account_address, owner_address);

CREATE TRIGGER solana_token_account_owner_observations_immutable
  BEFORE UPDATE OR DELETE ON solana_token_account_owner_observations
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

CREATE TABLE solana_owner_extractions (
  raw_object_hash content_hash PRIMARY KEY REFERENCES raw_objects(object_hash),
  extracted_at utc_timestamp NOT NULL,
  extractor_version integer NOT NULL CHECK (extractor_version > 0),
  observation_count integer NOT NULL CHECK (observation_count >= 0),
  record_hash content_hash NOT NULL UNIQUE
);

CREATE TRIGGER solana_owner_extractions_immutable
  BEFORE UPDATE OR DELETE ON solana_owner_extractions
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
