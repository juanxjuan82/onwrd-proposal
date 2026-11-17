ALTER TABLE tender_sources
  ADD COLUMN IF NOT EXISTS configuration_version integer NOT NULL DEFAULT 1;

ALTER TABLE crawler_runs
  ADD COLUMN IF NOT EXISTS source_configuration_version integer NOT NULL DEFAULT 0;