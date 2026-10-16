BEGIN;

CREATE TABLE paper_style_position_events (
  event_id text PRIMARY KEY,
  position_id text NOT NULL,
  decision_id text NOT NULL REFERENCES paper_style_selections(decision_id),
  fill_id text NOT NULL REFERENCES paper_fill_events(fill_id),
  event_type text NOT NULL CHECK (event_type IN ('OPEN', 'CLOSE')),
  observed_at utc_timestamp NOT NULL,
  style_id text NOT NULL,
  style_version text NOT NULL,
  price_usd numeric(38, 18) NOT NULL CHECK (price_usd > 0),
  quantity_atomic atomic_quantity NOT NULL,
  notional_usd numeric(38, 18) NOT NULL CHECK (notional_usd >= 0),
  realized_pnl_usd numeric(38, 18),
  content_hash content_hash NOT NULL UNIQUE,
  UNIQUE (position_id, event_type),
  CHECK ((event_type = 'CLOSE') = (realized_pnl_usd IS NOT NULL))
);

CREATE INDEX paper_style_position_events_status
  ON paper_style_position_events (position_id, observed_at DESC);

CREATE TRIGGER paper_style_position_events_immutable
  BEFORE UPDATE OR DELETE ON paper_style_position_events
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
