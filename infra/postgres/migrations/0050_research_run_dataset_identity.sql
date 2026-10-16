BEGIN;

ALTER TABLE research_analysis_runs
  ADD COLUMN dataset_hash content_hash;

ALTER TABLE research_analysis_runs DISABLE TRIGGER research_analysis_runs_immutable;

UPDATE research_analysis_runs run
SET dataset_hash = COALESCE(
  (SELECT packet.packet->>'datasetHash'
   FROM research_finding_packets packet
   WHERE packet.run_id = run.run_id
   ORDER BY packet.generated_at DESC
   LIMIT 1),
  run.content_hash
);

ALTER TABLE research_analysis_runs ENABLE TRIGGER research_analysis_runs_immutable;

ALTER TABLE research_analysis_runs
  ALTER COLUMN dataset_hash SET NOT NULL;

ALTER TABLE research_analysis_runs
  DROP CONSTRAINT research_analysis_runs_protocol_id_analysis_family_analysis_key;

ALTER TABLE research_analysis_runs
  ADD CONSTRAINT research_analysis_runs_dataset_identity
  UNIQUE (protocol_id, analysis_family, analysis_version, code_hash, dataset_hash);

COMMIT;
