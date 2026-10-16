BEGIN;

CREATE TABLE paper_agent_cases (
  case_id text PRIMARY KEY,
  proposal_id text NOT NULL,
  created_at utc_timestamp NOT NULL,
  pipeline_input jsonb NOT NULL,
  content_hash content_hash NOT NULL UNIQUE
);

CREATE TABLE paper_agent_jobs (
  job_id text PRIMARY KEY,
  case_id text NOT NULL UNIQUE REFERENCES paper_agent_cases(case_id),
  status text NOT NULL CHECK (status IN ('PENDING','PROCESSING','COMPLETE','FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at utc_timestamp NOT NULL,
  lease_owner text,
  lease_expires_at utc_timestamp,
  last_error text,
  created_at utc_timestamp NOT NULL
);

CREATE INDEX paper_agent_jobs_claim ON paper_agent_jobs (status, available_at, created_at);

CREATE TABLE paper_agent_runs (
  run_id text PRIMARY KEY,
  case_id text NOT NULL UNIQUE REFERENCES paper_agent_cases(case_id),
  completed_at utc_timestamp NOT NULL,
  authority text NOT NULL CHECK (authority = 'PAPER_ONLY_NO_EXECUTION'),
  outcome text NOT NULL CHECK (outcome IN ('HALTED','REJECTED','SIMULATED_AND_RECONCILED')),
  stopped_at text NOT NULL,
  trace jsonb NOT NULL,
  trace_hash content_hash NOT NULL,
  content_hash content_hash NOT NULL UNIQUE
);

CREATE TRIGGER paper_agent_cases_immutable BEFORE UPDATE OR DELETE ON paper_agent_cases FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();
CREATE TRIGGER paper_agent_runs_immutable BEFORE UPDATE OR DELETE ON paper_agent_runs FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
