---
name: Analysis pipeline design
description: Architecture decisions for the AI requirements-extraction pipeline in opportunities.ts
---

## Rule
The extraction pipeline makes ONE AI call per step — it does not loop or retry with growing context. Each step has its own status string written to the DB as it starts.

**Why:** Looping approaches accumulated latency and cost; a single call with tight output constraints (≤40 requirements, ≤250 chars each, max_completion_tokens=1500) is faster and predictable.

## How to apply
- Step statuses: `requirements_extracting` → `bid_scoring` → `strategy_generating` → `screened` / `no_bid`
- `analysis_failed` is written on any unhandled error; `failedStep` and `failedErrorCode` stored in DB
- Text truncation: `truncateToTokenBudget()` keeps HEAD (30k chars) + TAIL (15k chars) with an ellipsis marker — always call before submitting tender document to AI
- Timeout: 90-second AbortController signal wraps every AI call
- Retry policy: `callWithSingleRetry(fn, retryDelayMs)` — retries once on `rate_limit_exceeded` / network errors; quota errors (`insufficient_quota`) are re-thrown immediately with NO retry
- Existing requirements are preserved when the AI returns zero results (guard against accidental wipe)
- Token usage (prompt + completion) and model name are recorded in DB columns after each call
- Duplicate-click guard: `POST /opportunities/:id/analyze` returns 409 if status is in `ANALYSIS_ACTIVE_STATUSES`
- Stale-job recovery: `recoverStaleAnalysisJobs()` runs at server startup; marks tenders stuck in an active status for >5 min (`STALE_JOB_MS = 5 * 60 * 1000`) as `analysis_failed`
