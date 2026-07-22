---
name: AI gateway pattern
description: Single permitted openai importer; enforced by build guard; invokeAI() is the only call site.
---

# AI gateway pattern

## Rule
`artifacts/api-server/src/lib/ai-gateway.ts` is the **only** file permitted to import from the openai integration package. All other source files must call `invokeAI()` instead.

**Why:** Prevent scattered direct openai calls that bypass quota tracking, the circuit breaker, and the feature allowlist.

## How to apply
- Every new AI-using route must `import { invokeAI } from "../lib/ai-gateway.js"` (or the equivalent relative path).
- The build guard (`build.mjs` → `checkGatewayBoundary()`) scans all `.ts` files in `src/` at build time and fails the build if any file other than `ai-gateway.ts` contains the forbidden import string.
- `invokeAI` params: `{ feature, messages, maxTokens, responseFormat?, signal?, permitRetry?, opportunityId?, proposalId?, operationKey? }`.
- Returns `AIResult { content: string; model: string; usage?: { promptTokens, completionTokens, totalTokens } }`.
- Feature allowlist (5 features): `requirements_extraction`, `strategy_generation`, `proposal_generation`, `proposal_check`, `section_regeneration`.
- Circuit breaker is module-level in-memory; resets on server restart. A follow-up task (#14) covers promoting it to DB-backed state.
