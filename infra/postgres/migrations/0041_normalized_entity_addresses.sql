BEGIN;

CREATE TABLE entity_addresses (
  entity_id text NOT NULL REFERENCES entities(entity_id),
  address text NOT NULL,
  PRIMARY KEY (entity_id, address)
);

CREATE INDEX entity_addresses_address_lookup
  ON entity_addresses (address, entity_id);

INSERT INTO entity_addresses (entity_id, address)
SELECT entity.entity_id, address.value
FROM entities entity
CROSS JOIN LATERAL jsonb_array_elements_text(entity.addresses) address(value)
ON CONFLICT (entity_id, address) DO NOTHING;

CREATE TRIGGER entity_addresses_immutable
  BEFORE UPDATE OR DELETE ON entity_addresses
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
