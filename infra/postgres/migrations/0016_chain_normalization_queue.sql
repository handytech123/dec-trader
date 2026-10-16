BEGIN;

CREATE TABLE chain_normalization_jobs (
  raw_object_hash content_hash NOT NULL REFERENCES raw_objects(object_hash),
  parser_version integer NOT NULL CHECK (parser_version > 0),
  provider_id text NOT NULL,
  chain text NOT NULL,
  slot numeric(20, 0) NOT NULL CHECK (slot >= 0),
  status text NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETE', 'FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at utc_timestamp NOT NULL,
  claimed_at utc_timestamp,
  completed_at utc_timestamp,
  last_error text,
  created_at utc_timestamp NOT NULL,
  updated_at utc_timestamp NOT NULL,
  PRIMARY KEY (raw_object_hash, parser_version),
  CHECK ((status = 'COMPLETE') = (completed_at IS NOT NULL))
);

CREATE INDEX chain_normalization_jobs_available
  ON chain_normalization_jobs (status, available_at, slot);

COMMIT;
