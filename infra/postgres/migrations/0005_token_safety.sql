BEGIN;
CREATE TABLE token_safety_assessments (
  mint text NOT NULL,
  assessed_at utc_timestamp NOT NULL,
  rpc_slot bigint NOT NULL CHECK (rpc_slot >= 0),
  assessment_version integer NOT NULL CHECK (assessment_version > 0),
  status text NOT NULL CHECK (status IN ('PASS', 'REVIEW', 'BLOCK')),
  reasons jsonb NOT NULL,
  facts jsonb NOT NULL,
  content_hash content_hash NOT NULL,
  PRIMARY KEY (mint, assessed_at, assessment_version)
);
CREATE INDEX token_safety_latest ON token_safety_assessments (mint, assessed_at DESC);
COMMIT;
