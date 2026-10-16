BEGIN;

ALTER TABLE research_analysis_runs
  DROP CONSTRAINT research_analysis_runs_analysis_family_check;

ALTER TABLE research_analysis_runs
  ADD CONSTRAINT research_analysis_runs_analysis_family_check
  CHECK (analysis_family IN ('TRANSFER_MAGNITUDE', 'DIRECTION'));

COMMIT;
