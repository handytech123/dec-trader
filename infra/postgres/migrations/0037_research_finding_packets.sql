BEGIN;

CREATE TABLE research_finding_packets (
  packet_hash content_hash PRIMARY KEY,
  protocol_id text NOT NULL REFERENCES research_protocols(protocol_id),
  run_id text NOT NULL REFERENCES research_analysis_runs(run_id),
  hypothesis_id text NOT NULL,
  classification text NOT NULL CHECK (
    classification IN ('SUPPORTED','NOT_SUPPORTED','INSUFFICIENT_DATA','INVALIDATED_DATA_QUALITY')
  ),
  generated_at utc_timestamp NOT NULL,
  packet jsonb NOT NULL,
  UNIQUE (protocol_id, run_id, hypothesis_id)
);

CREATE TRIGGER research_finding_packets_immutable
  BEFORE UPDATE OR DELETE ON research_finding_packets
  FOR EACH ROW EXECUTE FUNCTION reject_published_record_mutation();

COMMIT;
