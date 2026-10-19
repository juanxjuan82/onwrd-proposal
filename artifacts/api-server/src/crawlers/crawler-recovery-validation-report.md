# Crawler recovery validation report

**Checked:** 2026-10-19
**PR:** existing open draft PR #2 on `fix/crawler-discovery-enrichment-pr1`; no replacement PR was created.
**Scope:** read-only public-source checks and fixture tests; no live discoveries were inserted or promoted.

## Before and after

| Source | Before the extraction/recovery changes | After the changes |
| --- | --- | --- |
| CDB | `robots.txt` returned HTTP 200 and did not disallow the procurement-notices path. One public listing returned HTTP 200 (56,821 bytes); five notice links were identified. One detail page returned HTTP 200; a manual main-content pass yielded about 6,380 characters. That sample’s PDF-only link scan found no PDF. No database qualification or promotion was attempted. | The adapter rechecked `robots.txt` for this run (allowed), fetched five notice records, and extracted substantive scope from all five detail pages: 19,471 description characters total. All five deadlines parsed; there were zero detail-fetch failures. One attached TOR was extracted, and four notices had no document link. Deterministic eligibility qualified 0/5; live promotions: 0. Requests are spaced at least one second apart and the run is capped at five notices. CDB stays inactive until a versioned, source-specific pilot is recorded. |
| CARICOM | Earlier validation incorrectly treated the robots policy as site-wide and made no listing/detail request; extraction was fixture-only. | Live `robots.txt` returned HTTP 200 and permits `/procurement-notices/`, `/procurement/`, and `/wp-content/uploads/`. The procurement listing returned HTTP 200 (145,837 bytes) and showed seven open notices. The adapter fetched the first five, extracted substantive detail for 5/5, parsed all five closing dates, and had zero detail-fetch failures. Two attached PDF copies from one notice were extracted (1,762 characters each). Deterministic eligibility qualified 0/5; live promotions: 0. Requests are spaced at least one second apart and the run is capped at five notices. CARICOM remains inactive pending a versioned controlled pilot. |
| UNDP | `robots.txt` returned HTTP 200 and disallowed `/`; no procurement page was requested. | Still blocked and inactive; the adapter fails closed before making a procurement request. |

The pre-change CDB numbers are a single live sample, not a complete crawl. The old adapter was not run against live sources: its broad listing behavior was not appropriate for a respectful baseline crawl. The after-check used the new CDB and CARICOM adapters; both recheck robots policy, pace requests at least one second apart, cap each run at five notices, and do not write to the database.

## Failures and qualification

- Live CDB notice listing/detail failures: **0**. Notice pages with substantive content: **5/5**. Parsed deadlines: **5/5**.
- Live CDB document results: **1 extracted attachment**, **4 notices with no document link**. Fixture coverage separately distinguishes a failed fetch, malformed PDF, textless/scanned PDF, unsupported document, and a notice with insufficient scope.
- Live CARICOM notice listing/detail failures: **0**. Substantive details and parsed closing dates: **5/5**. The attached PDF links were retained with provenance and both extracted successfully.
- Live qualification: **0 qualified, 0 promoted** across CDB and CARICOM. None of the fetched notices passed the explicit service-scope eligibility gate. No live promotion was attempted.
- A substantive Caribbean communications fixture does pass deterministic scoring and crawler eligibility to the canonical `new` destination. Recovery tests verify refresh eligibility, score recomputation, the status/unlinked guards, and use of the canonical promotion path. Linked records receive attachment evidence only; proposal-backed opportunity fields, human decisions, and human-edited descriptions are not overwritten.
- CARICOM is accessible on its procurement paths but remains inactive pending a successful configuration-versioned pilot. UNDP remains inaccessible for automated notice retrieval under its site-wide robots disallow. No access restrictions were bypassed.

## Automated checks

- Crawler extraction/recovery tests: **pass**, including live-policy robots enforcement for CDB, CARICOM, and UNDP.
- API TypeScript typecheck: **pass**.
- API build: **pass**.
- Full API test suite: **641/641 passed**. API TypeScript typecheck and build also passed.
