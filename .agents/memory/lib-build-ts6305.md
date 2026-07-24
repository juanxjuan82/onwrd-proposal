---
name: Lib build to fix TS6305
description: How to resolve TS6305 "output file has not been built" errors for composite workspace libs
---

## Rule
When `pnpm typecheck` reports `TS6305: Output file '...lib/X/dist/index.d.ts' has not been built`, run
`npx tsc --build lib/X` to generate the dist before re-running typecheck.

## The three libs and their known build issues
- `lib/db` — builds cleanly; run first
- `lib/api-zod` — had duplicate `export * from "./generated/types"` (same names as `api.ts`); removed that line to unblock build
- `lib/integrations-openai-ai-server` — had `pRetry.AbortError` (use named `AbortError` import), `response.data` possibly-undefined (add `!`), and `types:["node"]` without @types/node installed (remove from tsconfig)

**Why:** `composite: true` + `noEmitOnError: true` in each lib tsconfig means the lib won't emit unless its own source is error-free. Lib source errors cascade to TS6305 in consumers.

**How to apply:** Before running typecheck on api-server, always ensure all three libs have been built. Add `npx tsc --build lib/db lib/api-zod lib/integrations-openai-ai-server` to the CI or pre-typecheck script if needed.

## rootDir cross-package import restriction
When a test in `artifacts/api-server/src/` imports from `artifacts/proposal-generator/src/`, TypeScript rejects it with TS6059 (file not under rootDir). Fix: place shared pure-logic predicates in `artifacts/api-server/src/lib/` for tests, and a matching copy in `proposal-generator/src/lib/` for the frontend.
