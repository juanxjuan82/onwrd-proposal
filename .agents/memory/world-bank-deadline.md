---
name: World Bank adapter deadline field
description: World Bank procnotices API has two date fields; the wrong one was used as the bid deadline, causing all items to appear expired.
---

The World Bank `/api/v2/procnotices` endpoint returns two date fields:
- `submission_date` — the **notice publication date** (always in the past once fetched)
- `submission_deadline_date` — the **actual bid deadline** (future-dated for open notices)

The adapter was originally mapping `submission_date` → `deadline`, which caused the eligibility gate to reject every World Bank item as `deadline_expired`. All 184 stored items had past deadlines for this reason.

**Fix**: use `submission_deadline_date ?? submission_date` as the deadline, and add a client-side filter to skip items where deadline ≤ now.

**Also**: The Solr `fq` (filter query) parameter for `project_ctry_name` is silently ignored by the World Bank API endpoint — every `fq` value returns the full 412k+ dataset with identical totals. Use the `q` (full-text search) parameter for geographic/topic targeting instead. Queries like `q=communications marketing Caribbean Bahamas Jamaica` are the only effective way to target results.

**Why**: The API wraps a Solr index but the `fq` parameter is not proxied correctly to the underlying Solr instance. `q` goes through a different path and does filter results.
