---
name: Crawler quota design
description: How the tender crawler manages AI quota, circuit breaking, and overlap prevention
---

## Rule
Keyword scorer always runs first. AI is only called for PURSUE/CONSIDER results where the description is non-boilerplate (≥120 chars, no stub patterns), the per-crawl cap (20 calls) hasn't been reached, and the quota circuit is closed.

**Why:** OpenAI quota errors are permanent for the billing period — retrying them is wasteful. Boilerplate descriptions add noise without helping the AI produce better scores.

## How to apply
- `isQuotaError()` → open circuit immediately, no retry, keyword fallback for rest of crawl
- `isTemporaryRateLimitError()` → retry up to 3 times with 3s/6s backoff
- `isCrawlRunning()` exported getter → routes check this synchronously before calling `runCrawler()` (async throw would not be catchable at call site)
- Per-crawl `CrawlTelemetry` object passed by reference through `scoreOpportunity()`; per-source deltas recorded by snapshotting counts before each source loop

## Columns added to crawler_runs
aiProvider, aiModel, aiCallCount, aiFallbackCount, aiQuotaError (DB pushed 2026-07-21)
