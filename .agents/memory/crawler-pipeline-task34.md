---
name: Crawler pipeline Task 34 overhaul
description: Architecture decisions and key constraints from the crawl ingestion and Discover visibility fix
---

# Crawler Pipeline — Ingestion Overhaul

## What was built

Four structural defects were fixed:

1. **Adapter contract** — all 8 adapters now return `AdapterFetchResult { opportunities, requestsAttempted, requestsSucceeded, warnings }` and THROW on total failure. The old pattern of silent `catch {}` / `if (!r.ok) continue` returning empty arrays is removed.

2. **Upsert-and-reconcile** — `reconcileDiscovery()` in `lib/discovery-reconciler.ts` replaces the skip-on-duplicate pattern. Content-key comparison detects changes; changed items are updated + rescored + re-evaluated. All paths (live crawl, backfill) go through this single service.

3. **Detail page fetching** — UNDP adapter fetches each notice's detail page (concurrency=4, 20s timeout per request) to replace title-only stubs with real scope text. Other adapters track attempts/successes.

4. **Batch observability** — `crawl_batches` table (UUID PK); `POST /crawl` returns 202 + batchId; `GET /crawl-batches/:id` for polling. Frontend polls batch endpoint for specific outcome messages.

## Key constraints

**Why `discovery-scoring.ts` is separate from `crawlers/index.ts`:** The scorer needed to be importable by `discovery-reconciler.ts` without creating a circular dep (`reconciler → index → reconciler`). `discovery-scoring.ts` is a pure-function module with no DB deps.

**Why adapters THROW on total failure:** A failed source must be recorded as `status="failed"` in `crawler_runs`, not `status="success"` with `itemsFound=0`. The throw propagates to the `catch` block in `runCrawler()`.

**Backfill scope:** `backfillPromotions()` queries `opportunityId IS NULL AND (deadline IS NULL OR deadline > NOW())` — no pre-filter on recommendation. Old version pre-filtered to CONSIDER/PURSUE, missing previously-SKIP items that would now qualify after phrase expansion.

**Batch status logic:**
- `sourcesAttempted === 0` → `"failed"`
- `sourcesFailed === sourcesAttempted` → `"failed"`  
- `sourcesFailed > 0` → `"partial"`
- otherwise → `"success"`

**DB migrations** are in `app.ts` `dbReady` chain (idempotent `ALTER TABLE IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`). No drizzle-kit push — it hangs on interactive prompt.

## Files created/modified

- `lib/db/src/schema/crawl-batches.ts` (new)
- `lib/db/src/schema/crawler-runs.ts` (new columns: batchId, requestsAttempted/Succeeded, warnings, itemsUpdated/Eligible/Promoted/Rejected/Unchanged, rejectionCounts)
- `lib/db/src/schema/discovered-tenders.ts` (new: rejectionReasons JSONB)
- `artifacts/api-server/src/crawlers/base-adapter.ts` (AdapterFetchResult interface)
- `artifacts/api-server/src/lib/discovery-reconciler.ts` (new — centralised reconcile)
- `artifacts/api-server/src/lib/discovery-scoring.ts` (new — extracted pure scorer)
- `artifacts/api-server/src/crawlers/{world-bank,ungm,idb,cdb,bahamas-gov,cto,caricom,eu-caribbean}.ts` (AdapterFetchResult)
- `artifacts/api-server/src/crawlers/index.ts` (runCrawler with batches, backfillPromotions fix)
- `artifacts/api-server/src/routes/tender-intelligence.ts` (POST /crawl 202, GET /crawl-batches/:id)
- `artifacts/proposal-generator/src/pages/opportunities.tsx` (batchId polling)
- `artifacts/api-server/src/crawlers/crawler-pipeline.test.ts` (16 behavioral tests)

**Why:** Fixes the root cause of Discover showing 0 new opportunities: items were being skipped as duplicates (never refreshed) and 92% were `title_only` content that failed the promotion gate because adapters returned only listing-page stubs with no detail.
