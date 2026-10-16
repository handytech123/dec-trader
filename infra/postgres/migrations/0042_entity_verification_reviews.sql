BEGIN;

CREATE TABLE entity_verification_reviews (
  review_id text PRIMARY KEY,
  address text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING','VERIFIED','REJECTED','DEFERRED')),
  decided_at utc_timestamp NOT NULL,
  reviewer text NOT NULL,
  rationale text NOT NULL,
  proposed_entity_type text CHECK (proposed_entity_type IN ('EXCHANGE','BRIDGE','PROTOCOL','CONTRACT','POOL')),
  proposed_label text,
  source text,
  source_url text,
  evidence_hash content_hash,
  valid_from utc_timestamp,
  record_hash content_hash NOT NULL UNIQUE,
  CHECK (
    status <> 'VERIFIED' OR
    (proposed_entity_type IS NOT NULL AND proposed_label IS NOT NULL AND source IS NOT NULL AND
     source_url IS NOT NULL AND evidence_hash IS NOT NULL AND valid_from IS NOT NULL)
  )
);

CREATE INDEX entity_verification_reviews_latest
  ON entity_verification_reviews (address, decided_at DESC, review_id DESC);

CREATE TRIGGER entity_verification_reviews_immutable
  BEFORE UPDATE OR DELETE ON entity_verification_reviews
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
