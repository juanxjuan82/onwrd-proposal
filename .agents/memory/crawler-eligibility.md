---
name: Crawler eligibility gate
description: evaluateCrawlerEligibility() design — phrase matching, hard negatives, content quality, adapter context separation
---

## The rule
All new crawler discoveries are evaluated by `evaluateCrawlerEligibility()` before being promoted to canonical Opportunities. Only `eligible=true` records are promoted; all others are stored in `discovered_tenders` for human review.

## File
`artifacts/api-server/src/lib/crawler-eligibility.ts`

## Key design decisions

**Phrase/word-boundary matching (not raw substring)**
- Multi-word phrases → case-insensitive substring (phrase-anchored, e.g. `"marketing strategy"`)
- Single words → `\bword\b` regex (e.g. `"rebranding"`, `"copywriting"`)
- Generic single words (`"communications"`, `"campaign"`, `"brand"`, `"tourism"`) are NOT in `CORE_SERVICE_PHRASES` and cannot qualify a record alone.

**Content quality classification**
- `boilerplate`: matches known stub regexes
- `title_only`: description < 120 chars, OR after stripping the title < 60 chars remain
- `partial_scope`: 120–199 chars with real content
- `full_scope`: ≥ 200 chars

`title_only` and `boilerplate` → always `raw_only` (not promoted).

**Hard negative phrases**
`HARD_NEGATIVE_PHRASES` array covers: civil works, road construction, medical/pharma supplies, IT hardware, financial audit, security guards, catering, job postings, award notices, vendor registration, etc.
If the **title** matches a hard negative AND the **description** contains < 2 ONWRD core phrases → rejected.

**Destination mapping**
- `PURSUE + eligible` → `destination = "new"` → `promoteDiscoveredTender(id, "new")` → status `opportunity_found` + deterministic scoring
- `CONSIDER + eligible` → `destination = "reviewing"` → `promoteDiscoveredTender(id, "reviewing")` → status `pending_review`, no scoring
- `SKIP` or any rejection → `destination = "raw_only"` → not promoted

**Why:**
Adapters were injecting synthetic marketing phrases (e.g. "Tourism destination marketing and communications for the Caribbean region.") into `description`, which caused records to pass the relevance gate and be auto-promoted even with no real scope content. Moving adapter context to `rawData.adapterContext` and enforcing content quality + phrase matching prevents false positives.

## Adapter context separation
CTO, CARICOM, and EU-Caribbean adapters now set:
- `description`: `"[Org] procurement notice: [title]"` — short, title_only → not promoted without real content
- `rawData.adapterContext`: the marketing context sentence, for human reference only

The `keywordScore()` function in `crawlers/index.ts` already excludes `rawData` from its corpus, so adapter context never influences scoring.

## How to apply
- When adding a new adapter: never inject marketing assumptions into `description`. Use `rawData.adapterContext` for adapter notes.
- When adding new ONWRD service phrases: add to `CORE_SERVICE_PHRASES` as multi-word phrases or `\b`-anchored single words.
- Hard negatives go in `HARD_NEGATIVE_PHRASES` (title-dominant check triggers rejection).
- Tests: `src/lib/crawler-eligibility.test.ts`

## Adapter conventions (added Nov 2026)
- IDs: always `stableId(prefix, url)` from `crawlers/base-adapter.ts` (full SHA-1). Never build IDs from a truncated title/URL — the old base64-slice kept only 12 characters and made unrelated notices collide.
- Adapters return headline-only descriptions; `runCrawler()` then calls `enrichOpportunity()` for each NEW item to read the notice page/PDF (real scope text + deadline). Set `skipDetailFetch = true` only when the adapter already has full text (World Bank API) or the pages are unreadable (Bahamas Bonfire).
- Adapters must THROW when no listing page can be loaded (use `fetchListingHtml`). Never swallow errors and return `[]` — the Sources page flags failing/empty sources from crawler_runs.
- World Bank: `submission_date` is the PUBLISH date; the deadline is `submission_deadline_date`.
