BEGIN;

CREATE TABLE entities (
  entity_id text PRIMARY KEY,
  entity_type text NOT NULL CHECK (
    entity_type IN ('ADDRESS', 'CLUSTER', 'EXCHANGE', 'BRIDGE', 'PROTOCOL', 'CONTRACT', 'POOL')
  ),
  labels jsonb NOT NULL,
  addresses jsonb NOT NULL,
  attribution text NOT NULL CHECK (attribution IN ('VERIFIED', 'HEURISTIC', 'UNKNOWN')),
  confidence numeric(5, 4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  first_seen utc_timestamp NOT NULL,
  last_seen utc_timestamp NOT NULL,
  evidence jsonb NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  record_hash content_hash NOT NULL UNIQUE,
  CHECK (first_seen <= last_seen)
);

CREATE TABLE entity_relationships (
  relationship_id text PRIMARY KEY,
  from_entity_id text NOT NULL REFERENCES entities(entity_id),
  to_entity_id text NOT NULL REFERENCES entities(entity_id),
  relationship_type text NOT NULL,
  first_seen utc_timestamp NOT NULL,
  last_seen utc_timestamp NOT NULL,
  event_count bigint NOT NULL CHECK (event_count > 0),
  usd_value numeric(38, 18) NOT NULL CHECK (usd_value >= 0),
  confidence numeric(5, 4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  evidence_refs jsonb NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  record_hash content_hash NOT NULL UNIQUE,
  CHECK (from_entity_id <> to_entity_id),
  CHECK (first_seen <= last_seen)
);
CREATE INDEX entity_relationships_from ON entity_relationships (from_entity_id, last_seen DESC);
CREATE INDEX entity_relationships_to ON entity_relationships (to_entity_id, last_seen DESC);

CREATE TABLE capital_events (
  event_id text PRIMARY KEY,
  event_time utc_timestamp NOT NULL,
  ingest_time utc_timestamp NOT NULL,
  source text NOT NULL,
  chain text NOT NULL,
  venue text,
  event_type text NOT NULL,
  asset_id text NOT NULL REFERENCES assets(asset_id),
  quantity numeric(38, 18) NOT NULL CHECK (quantity >= 0),
  usd_value_at_event numeric(38, 18) CHECK (usd_value_at_event >= 0),
  from_entity_id text REFERENCES entities(entity_id),
  to_entity_id text REFERENCES entities(entity_id),
  transaction_hash text,
  confidence numeric(5, 4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  raw_ref content_hash NOT NULL REFERENCES raw_observations(record_hash),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  record_hash content_hash NOT NULL UNIQUE,
  CHECK (from_entity_id IS NOT NULL OR to_entity_id IS NOT NULL)
);
CREATE INDEX capital_events_point_in_time ON capital_events (asset_id, event_time, event_id);
CREATE INDEX capital_events_from_entity ON capital_events (from_entity_id, event_time DESC);
CREATE INDEX capital_events_to_entity ON capital_events (to_entity_id, event_time DESC);

CREATE TRIGGER entities_immutable
  BEFORE UPDATE OR DELETE ON entities
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();
CREATE TRIGGER entity_relationships_immutable
  BEFORE UPDATE OR DELETE ON entity_relationships
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();
CREATE TRIGGER capital_events_immutable
  BEFORE UPDATE OR DELETE ON capital_events
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
