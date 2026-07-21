---
name: Pre-existing TypeScript errors
description: sections.ts and tenders.ts have TS errors that predate current work; pnpm typecheck exit 2 is not a regression
---

## Rule
`pnpm typecheck` in api-server exits with code 2 due to pre-existing errors:
- `src/routes/sections.ts` — implicit `any` on callback params (lines ~153, 212-220, 281, 340, 353, 389)
- `src/routes/tenders.ts` and `tender-intelligence.ts` — TS6305 "output file not built from source" for `@workspace/db`, `@workspace/integrations-openai-ai-server`, `@workspace/api-zod`

**Why:** These files existed before the current refactor. The TS6305 errors appear because workspace package declarations haven't been rebuilt.

**How to apply:** When verifying that new code doesn't introduce regressions, grep the typecheck output for errors in the files you changed, and ignore errors in the pre-existing files listed above.
