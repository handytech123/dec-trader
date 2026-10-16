BEGIN;

CREATE TABLE paper_style_profiles (
  profile_id text PRIMARY KEY,
  style_id text NOT NULL,
  style_version text NOT NULL,
  trained_at utc_timestamp NOT NULL,
  status text NOT NULL CHECK (status IN ('APPROVED_FOR_PAPER', 'RESEARCH_ONLY', 'REJECTED')),
  validation_verdict text NOT NULL CHECK (validation_verdict IN ('NOT_TESTED', 'WALK_FORWARD_PASS', 'WALK_FORWARD_FAIL')),
  profile jsonb NOT NULL,
  metrics jsonb NOT NULL,
  content_hash content_hash NOT NULL UNIQUE,
  UNIQUE (style_id, style_version, trained_at)
);

CREATE TABLE paper_style_selections (
  decision_id text PRIMARY KEY,
  as_of utc_timestamp NOT NULL,
  mode text NOT NULL CHECK (mode = 'PAPER_ONLY'),
  policy_version text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('SELECT_STYLE', 'NO_TRADE')),
  selected_style_id text,
  selected_style_version text,
  score_bps numeric(38, 18),
  reasons jsonb NOT NULL,
  market_state jsonb NOT NULL,
  candidates jsonb NOT NULL,
  content_hash content_hash NOT NULL UNIQUE,
  CHECK ((decision = 'NO_TRADE') = (selected_style_id IS NULL)),
  CHECK ((decision = 'NO_TRADE') = (selected_style_version IS NULL))
);

CREATE INDEX paper_style_selections_time ON paper_style_selections (as_of DESC);

CREATE TABLE paper_risk_verdicts (
  verdict_id text PRIMARY KEY,
  decision_id text NOT NULL REFERENCES paper_style_selections(decision_id),
  evaluated_at utc_timestamp NOT NULL,
  mode text NOT NULL CHECK (mode = 'PAPER_ONLY'),
  outcome text NOT NULL CHECK (outcome IN ('APPROVED_FOR_PAPER_FILL', 'REJECTED')),
  verdict jsonb NOT NULL,
  content_hash content_hash NOT NULL UNIQUE
);

CREATE TABLE paper_portfolio_snapshots (
  snapshot_id text PRIMARY KEY,
  portfolio_id text NOT NULL,
  portfolio_version integer NOT NULL CHECK (portfolio_version >= 0),
  observed_at utc_timestamp NOT NULL,
  balances_atomic jsonb NOT NULL,
  content_hash content_hash NOT NULL UNIQUE,
  UNIQUE (portfolio_id, portfolio_version)
);

CREATE TABLE paper_fill_events (
  fill_id text PRIMARY KEY,
  decision_id text NOT NULL REFERENCES paper_style_selections(decision_id),
  verdict_id text NOT NULL REFERENCES paper_risk_verdicts(verdict_id),
  portfolio_snapshot_id text NOT NULL REFERENCES paper_portfolio_snapshots(snapshot_id),
  observed_at utc_timestamp NOT NULL,
  status text NOT NULL CHECK (status IN ('FILLED', 'PARTIAL', 'REJECTED')),
  fill jsonb NOT NULL,
  content_hash content_hash NOT NULL UNIQUE
);

CREATE TRIGGER paper_style_profiles_immutable
  BEFORE UPDATE OR DELETE ON paper_style_profiles
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();
CREATE TRIGGER paper_style_selections_immutable
  BEFORE UPDATE OR DELETE ON paper_style_selections
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();
CREATE TRIGGER paper_risk_verdicts_immutable
  BEFORE UPDATE OR DELETE ON paper_risk_verdicts
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();
CREATE TRIGGER paper_portfolio_snapshots_immutable
  BEFORE UPDATE OR DELETE ON paper_portfolio_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();
CREATE TRIGGER paper_fill_events_immutable
  BEFORE UPDATE OR DELETE ON paper_fill_events
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
