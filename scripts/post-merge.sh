#!/bin/bash
set -euo pipefail

pnpm install --frozen-lockfile
npx tsc --build lib/db
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/migrations/20260827_crawl4ai_enrichment.sql

# Do not run `drizzle-kit push` here: it prompts when existing database
# constraints use a different generated name, and automatic merge setup has no
# stdin. Schema changes must use idempotent runtime/direct SQL migrations so
# merges stay safe and non-interactive.
