BEGIN;

CREATE TABLE market_stream_checkpoints (
  source text NOT NULL,
  venue text NOT NULL,
  product_id text NOT NULL,
  cursor_type text NOT NULL CHECK (cursor_type IN ('TRADE_ID')),
  cursor_value numeric(38, 0) NOT NULL CHECK (cursor_value >= 0),
  updated_at utc_timestamp NOT NULL,
  PRIMARY KEY (source, venue, product_id, cursor_type)
);

CREATE TABLE collection_service_leases (
  service_name text PRIMARY KEY,
  owner_id text NOT NULL,
  acquired_at utc_timestamp NOT NULL,
  heartbeat_at utc_timestamp NOT NULL,
  lease_expires_at utc_timestamp NOT NULL,
  status text NOT NULL CHECK (status IN ('RUNNING', 'STOPPED', 'FAILED')),
  last_error text,
  CHECK (acquired_at <= heartbeat_at),
  CHECK (heartbeat_at <= lease_expires_at)
);

CREATE INDEX collection_service_lease_expiry
  ON collection_service_leases (lease_expires_at);

COMMIT;
