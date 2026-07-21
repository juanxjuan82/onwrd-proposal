---
name: Scoring architecture
description: Bid scoring is deterministic rules-based, not AI; single entry point pattern
---

## Rule
Bid scoring for ONWRD opportunities is done via `scoring-rules.ts` (keyword banks, weighted sub-scores, deadline penalty, completeness). No OpenAI call.

`applyDeterministicScore(tenderId)` is the single entry point:
- Called by POST /opportunities (create) and PUT /opportunities/:id (update) — synchronous, instant
- Called by `runBidScoring()` in the analysis pipeline — pipeline step is now a thin wrapper

**Why:** AI-based scoring was slow (20-30s), non-deterministic, and consumed quota. Deterministic rules are instant, testable, and free to run on every save.

**How to apply:** If you need to re-score a tender, call `applyDeterministicScore(tenderId)` — not the old AI path. The pipeline step `runBidScoring` delegates to it automatically.
