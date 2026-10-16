BEGIN;

CREATE TABLE enrichment_claims (
  claim_id text PRIMARY KEY,
  subject_id text NOT NULL,
  claim_type text NOT NULL,
  claim_value jsonb NOT NULL,
  provider text NOT NULL,
  confidence numeric(5, 4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  evidence_refs jsonb NOT NULL,
  valid_from utc_timestamp,
  valid_to utc_timestamp,
  retrieved_at utc_timestamp NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  record_hash content_hash NOT NULL UNIQUE,
  CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_from <= valid_to)
);

CREATE INDEX enrichment_claims_subject_time
  ON enrichment_claims (subject_id, claim_type, retrieved_at DESC);

CREATE TRIGGER enrichment_claims_immutable
  BEFORE UPDATE OR DELETE ON enrichment_claims
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
