ALTER TABLE tender_sources
  ADD COLUMN IF NOT EXISTS browser_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE tender_sources
  ADD COLUMN IF NOT EXISTS approved_domains jsonb;

ALTER TABLE crawler_runs
  ADD COLUMN IF NOT EXISTS crawl_method text NOT NULL DEFAULT 'direct';

ALTER TABLE crawler_runs
  ADD COLUMN IF NOT EXISTS crawl4ai_attempts integer NOT NULL DEFAULT 0;

ALTER TABLE crawler_runs
  ADD COLUMN IF NOT EXISTS crawl4ai_successes integer NOT NULL DEFAULT 0;

ALTER TABLE crawler_runs
  ADD COLUMN IF NOT EXISTS crawl_diagnostics jsonb;

-- Opt in only the two approved HTML pilots. Without Crawl4AI environment
-- configuration they continue using direct fetch, so this remains disabled by
-- default at the service boundary.
UPDATE tender_sources
SET
  browser_enabled = true,
  approved_domains = CASE adapter_type
    WHEN 'bahamas_gov' THEN '["bahamas.gov.bs"]'::jsonb
    WHEN 'caricom' THEN '["caricom.org"]'::jsonb
    ELSE approved_domains
  END,
  updated_at = NOW()
WHERE adapter_type IN ('bahamas_gov', 'caricom');