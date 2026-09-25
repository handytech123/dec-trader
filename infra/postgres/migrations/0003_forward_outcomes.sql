BEGIN;

CREATE TABLE forward_outcomes (
  entry_record_hash content_hash NOT NULL REFERENCES dex_market_observations(record_hash),
  horizon text NOT NULL CHECK (horizon IN ('1h', '6h', '24h', '7d', '30d')),
  entry_at utc_timestamp NOT NULL,
  target_at utc_timestamp NOT NULL,
  exit_at utc_timestamp NOT NULL,
  entry_price numeric(38, 18) NOT NULL CHECK (entry_price > 0),
  exit_price numeric(38, 18) NOT NULL CHECK (exit_price >= 0),
  return_pct numeric(38, 18) NOT NULL,
  maximum_favorable_excursion_pct numeric(38, 18) NOT NULL,
  maximum_adverse_excursion_pct numeric(38, 18) NOT NULL,
  labeling_version integer NOT NULL CHECK (labeling_version > 0),
  labeled_at utc_timestamp NOT NULL,
  PRIMARY KEY (entry_record_hash, horizon, labeling_version)
);

CREATE INDEX forward_outcomes_horizon_exit
  ON forward_outcomes (horizon, exit_at);

COMMIT;
