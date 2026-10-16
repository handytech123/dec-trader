BEGIN;

ALTER TABLE research_analysis_runs
  DROP CONSTRAINT research_analysis_runs_analysis_family_check;

ALTER TABLE research_analysis_runs
  ADD CONSTRAINT research_analysis_runs_analysis_family_check
  CHECK (analysis_family IN (
    'TRANSFER_MAGNITUDE',
    'TRANSFER_MAGNITUDE_BTC_RELATIVE',
    'CAPITAL_FLOW_EPISODE_BTC_RELATIVE',
    'DIRECTION',
    'WALLET_BEHAVIOR',
    'MARKET_REACTION',
    'CONDITIONAL_COMBINATION'
  ));

COMMIT;
