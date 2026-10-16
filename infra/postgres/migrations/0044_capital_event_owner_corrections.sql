BEGIN;

CREATE TABLE capital_event_owner_corrections (
  event_id text NOT NULL REFERENCES capital_events(event_id),
  endpoint_side text NOT NULL CHECK (endpoint_side IN ('FROM','TO')),
  token_account_address text NOT NULL,
  owner_address text NOT NULL,
  raw_object_hash content_hash NOT NULL REFERENCES raw_objects(object_hash),
  PRIMARY KEY (event_id, endpoint_side)
);

CREATE INDEX capital_event_owner_corrections_owner
  ON capital_event_owner_corrections (owner_address, event_id);

INSERT INTO capital_event_owner_corrections
  (event_id, endpoint_side, token_account_address, owner_address, raw_object_hash)
SELECT event.event_id, endpoint.endpoint_side, endpoint.address, observation.owner_address,
       event.raw_ref
FROM capital_events event
CROSS JOIN LATERAL (
  SELECT 'FROM'::text AS endpoint_side, mapping.address
  FROM entity_addresses mapping WHERE mapping.entity_id = event.from_entity_id
  UNION ALL
  SELECT 'TO'::text AS endpoint_side, mapping.address
  FROM entity_addresses mapping WHERE mapping.entity_id = event.to_entity_id
) endpoint
JOIN solana_token_account_owner_observations observation
  ON observation.raw_object_hash = event.raw_ref
 AND observation.token_account_address = endpoint.address
ON CONFLICT (event_id, endpoint_side) DO NOTHING;

CREATE TRIGGER capital_event_owner_corrections_immutable
  BEFORE UPDATE OR DELETE ON capital_event_owner_corrections
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
