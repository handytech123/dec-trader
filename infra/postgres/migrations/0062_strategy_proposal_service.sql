BEGIN;

CREATE TABLE strategy_service_definitions (
  strategy_version_id text PRIMARY KEY,
  strategy_id text NOT NULL,
  version text NOT NULL,
  status text NOT NULL CHECK (status IN ('RESEARCH_ONLY', 'SHADOW_ELIGIBLE', 'PAPER_ELIGIBLE', 'RETIRED')),
  module_key text NOT NULL,
  configuration jsonb NOT NULL,
  registered_at utc_timestamp NOT NULL,
  content_hash content_hash NOT NULL UNIQUE,
  UNIQUE (strategy_id, version)
);

CREATE TABLE strategy_feature_snapshots (
  snapshot_id text PRIMARY KEY,
  feature_snapshot_id text NOT NULL,
  portfolio_snapshot_id text NOT NULL,
  observed_at utc_timestamp NOT NULL,
  as_of_slot atomic_quantity,
  mode text NOT NULL CHECK (mode IN ('BACKTEST', 'SHADOW', 'PAPER')),
  features jsonb NOT NULL,
  provenance jsonb NOT NULL,
  content_hash content_hash NOT NULL UNIQUE
);

CREATE TABLE strategy_evaluation_jobs (
  job_id text PRIMARY KEY,
  snapshot_id text NOT NULL REFERENCES strategy_feature_snapshots(snapshot_id),
  strategy_version_id text NOT NULL REFERENCES strategy_service_definitions(strategy_version_id),
  status text NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETE', 'FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at utc_timestamp NOT NULL,
  lease_owner text,
  lease_expires_at utc_timestamp,
  last_error text,
  created_at utc_timestamp NOT NULL,
  UNIQUE (snapshot_id, strategy_version_id)
);

CREATE INDEX strategy_evaluation_jobs_claim ON strategy_evaluation_jobs (status, available_at, created_at);

CREATE TABLE strategy_evaluations (
  evaluation_id text PRIMARY KEY,
  snapshot_id text NOT NULL REFERENCES strategy_feature_snapshots(snapshot_id),
  strategy_version_id text NOT NULL REFERENCES strategy_service_definitions(strategy_version_id),
  evaluated_at utc_timestamp NOT NULL,
  authority text NOT NULL CHECK (authority = 'PAPER_PROPOSAL_ONLY'),
  decision text NOT NULL CHECK (decision IN ('PROPOSE', 'NO_TRADE')),
  reasons jsonb NOT NULL,
  input_hash content_hash NOT NULL,
  result jsonb NOT NULL,
  content_hash content_hash NOT NULL UNIQUE,
  UNIQUE (snapshot_id, strategy_version_id)
);

CREATE TABLE strategy_trade_proposals (
  proposal_id text PRIMARY KEY,
  evaluation_id text NOT NULL REFERENCES strategy_evaluations(evaluation_id),
  strategy_version_id text NOT NULL REFERENCES strategy_service_definitions(strategy_version_id),
  valid_until utc_timestamp NOT NULL,
  proposal jsonb NOT NULL,
  proposal_hash content_hash NOT NULL UNIQUE
);

CREATE INDEX strategy_trade_proposals_expiry ON strategy_trade_proposals (valid_until DESC);

CREATE TRIGGER strategy_service_definitions_immutable BEFORE UPDATE OR DELETE ON strategy_service_definitions FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();
CREATE TRIGGER strategy_feature_snapshots_immutable BEFORE UPDATE OR DELETE ON strategy_feature_snapshots FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();
CREATE TRIGGER strategy_evaluations_immutable BEFORE UPDATE OR DELETE ON strategy_evaluations FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();
CREATE TRIGGER strategy_trade_proposals_immutable BEFORE UPDATE OR DELETE ON strategy_trade_proposals FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
