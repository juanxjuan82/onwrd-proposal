# Crawler recovery validation report

**Checked:** 2026-10-19
**Branch:** the existing draft PR #2 head, `fix/crawler-discovery-enrichment-pr1`
**Scope:** read-only public-source checks and fixture tests; no live discoveries were inserted or promoted.

## Before and after

| Source | Before the extraction/recovery changes | After the changes |
| --- | --- | --- |
| CDB | `robots.txt` returned HTTP 200 and did not disallow the procurement-notices path. One public listing returned HTTP 200 (56,821 bytes); five notice links were identified. One detail page returned HTTP 200; a manual main-content pass yielded about 6,380 characters. That sample’s PDF-only link scan found no PDF. No database qualification or promotion was attempted. | The adapter rechecked `robots.txt` (allowed; the result is cached for one hour), then retrieved five notice records and five substantive detail pages: 19,477 description characters total. All five deadlines parsed. The pages had zero detail-fetch failures; four had no document link, and one linked TOR was fetched and extracted as DOCX (12,000 characters). The deterministic score/eligibility gate qualified 0/5; live promotions: 0. CDB stays inactive until a versioned, source-specific pilot is recorded by the controlled activation flow. |
| CARICOM | `robots.txt` returned HTTP 200 and disallowed `/`; the procurement listing was not requested. | Still blocked and inactive; no listing/detail request was made. The fixture parser extracts the representative procurement-card scope and rejects navigation-only links. |
| UNDP | `robots.txt` returned HTTP 200 and disallowed `/`; no procurement page was requested. | Still blocked and inactive; the adapter fails closed before making a procurement request. |

The pre-change CDB numbers are a single live sample, not a complete crawl. The old adapter was not run against live sources: its broad listing behavior was not appropriate for a respectful baseline crawl. The after-check used the new CDB adapter, which paces same-host requests to at most one per second and does not write to the database.

## Failures and qualification

- Live CDB notice listing/detail failures: **0**. Notice pages with substantive content: **5/5**.
- Live CDB document results: **1 extracted DOCX TOR**, **4 notices with no document link**. Fixture coverage separately distinguishes a failed fetch, malformed PDF, textless/scanned PDF, unsupported document, and a notice with insufficient scope.
- Live qualification: **0 qualified, 0 promoted**. All five notices were scored `SKIP` and rejected by the existing deterministic relevance/eligibility gates. No live promotion was attempted because these unrelated notices should not be written to the opportunities database.
- A substantive Caribbean communications fixture does pass deterministic scoring and crawler eligibility to the canonical `new` destination. Recovery tests verify refresh eligibility, score recomputation, the status/unlinked guards, and use of the canonical promotion path. Linked records receive attachment evidence only; proposal-backed opportunity fields, human decisions, and human-edited descriptions are not overwritten.
- CARICOM and UNDP are inaccessible for automated retrieval under their observed robots rules. They remain inactive; no access restrictions were bypassed.

## Automated checks

- Crawler extraction/recovery tests: **pass**, including runtime robots-policy enforcement before the CDB listing request.
- API TypeScript typecheck: **pass**.
- API build: **pass**.
- Full API test suite: **443/443 passed**. The first full run exposed a timing-sensitive concurrent proposal-generation test; its AI test double now remains pending until the second request observes the in-progress state. The suite passed in full after that test-only stabilization.
