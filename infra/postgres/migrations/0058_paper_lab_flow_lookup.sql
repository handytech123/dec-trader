BEGIN;

CREATE INDEX protocol_flow_windows_point_in_time
  ON protocol_flow_windows (window_start DESC, feature_id);

COMMIT;
