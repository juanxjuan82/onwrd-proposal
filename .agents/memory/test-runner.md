---
name: Test runner choice
description: Why we use node:test + tsx instead of vitest in this workspace
---

## Rule
Use Node.js built-in `node:test` with tsx for TypeScript support. Do NOT add vitest.

**Why:** The Replit package firewall returns 403 for vitest tarballs, making `pnpm add vitest` fail with `ERR_PNPM_FETCH_403`. tsx@4.21.0 is already in the workspace pnpm catalog and virtual store, so it links without a network fetch.

## How to apply
- Test script: `"test": "node --import tsx/esm --test src/**/*.test.ts"` (or explicit file list)
- devDependency in package.json: `"tsx": "catalog:"`
- Import style: `import { describe, it } from "node:test"; import assert from "node:assert/strict";`
- No `expect()` — use `assert.equal`, `assert.ok`, `assert.rejects`, etc.
- For functions that have internal delays (e.g. retry sleeps), add an optional `delayMs = default` parameter and pass `0` in tests to avoid real sleeps — no fake timers needed
- tsx binary also available at `/home/runner/workspace/node_modules/.pnpm/node_modules/.bin/tsx` if needed in scripts
- **Path resolution in test files at `src/lib/` depth:** `__dirname` resolves to the `src/lib/` directory; reaching the workspace root requires 4 levels up (`path.resolve(__dirname, "../../../..")`), not 3 — otherwise the constructed paths double-nest the `artifacts/` segment
