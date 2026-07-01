---
name: Proposal Desk Architecture
description: Key decisions for the ONWRD Proposal Desk — schema, routes, AI, and integration patterns.
---

## Schema (lib/db/src/schema/)
10 tables total: `proposals`, `tenders`, `tender_requirements`, `bid_scores`, `proposal_sections`, `proposal_generation_runs`, `proposal_review_events`, `knowledge_documents`, `google_exports`, `notifications`. Extended `proposals` with `tenderId`, `googleFileId`, `driveFolderId`. Extended `tenders` with `rawText`, `requirementsExtractedAt`.

**Why:** All extensions are nullable additive columns — zero breaking changes to existing intake-flow proposals.

## AI Model
Use `gpt-5.2` (not `gpt-4o`, not `gpt-4-turbo`). This matches the pattern set in the codebase before compression. `response_format: { type: "json_object" }` for all structured extractions.

**Why:** The codebase was already using gpt-5.2 everywhere. Switching models mid-project risks inconsistency.

## OpenAI Client
Import from `@workspace/integrations-openai-ai-server` (named export `openai`). Uses `OPENAI_API_KEY` directly against standard OpenAI API. NOT the AI integrations proxy URL. Fixed during deployment crisis.

**Why:** `AI_INTEGRATIONS_OPENAI_BASE_URL` doesn't exist in production, causing crash. Direct API key approach is reliable.

## Section-based generation
`POST /api/opportunities/:id/generate-proposal` creates the proposal + 15 empty section rows, responds immediately (201), then generates all 15 sections in a single `gpt-5.2` call (json_object with "sections" array) in a fire-and-forget async IIFE. Frontend polls via `refetchInterval` until sections leave `not_started` status.

**Why:** 15 individual API calls would be slow and expensive. Single call is efficient. Fire-and-forget allows instant response while generation happens asynchronously.

## Section keys (15 fixed)
executive_summary, client_context, goals_kpis, strategic_approach, scope_of_work, deliverables, timeline, team_structure, investment, assumptions_risks, governance, why_onwrd, case_studies, legal_terms, next_steps.

## Quality gate
`POST /api/proposals/:id/approve-for-export` blocks export if sections have `blocked_missing_input` or `needs_review` status — unless `overrideReason` is provided in body. Returns 422 with `blockers` array when blocked.

**Why:** Prevents exporting proposals with [NEEDS ONWRD INPUT] placeholders without acknowledgement.

## Routes registered in
`artifacts/api-server/src/routes/index.ts` — all routes use `router.use()` without prefix (routes self-declare their paths).

## Backward compatibility
Existing intake-flow proposals (no `tenderId`, no sections) still work via the original flat `proposalContent` editor. Sections tab only appears when `proposal_sections` rows exist for that proposal.

## DB migration
Run `cd lib/db && npx drizzle-kit push` to apply schema to dev DB. Always confirm tables with pg query before restarting server.
