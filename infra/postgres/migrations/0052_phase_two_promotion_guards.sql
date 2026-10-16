BEGIN;

ALTER TABLE research_promotion_records
  ADD CONSTRAINT research_promotion_future_only
    CHECK (future_holdout_start > created_at),
  ADD CONSTRAINT research_promotion_approval_requires_eligible_gate
    CHECK (
      decision <> 'APPROVED_FOR_ONE_SHOT_HOLDOUT'
      OR gate_result @> '{"eligible": true}'::jsonb
    );

COMMIT;
