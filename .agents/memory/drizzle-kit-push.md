---
name: drizzle-kit push blocked
description: drizzle-kit push hangs waiting for interactive confirmation; use direct SQL instead
---

## Rule
`pnpm --filter @workspace/db drizzle-kit push` blocks indefinitely waiting for interactive Y/N confirmation about destructive changes. It cannot be run non-interactively in this environment.

**Why:** The Replit sandbox stdin is not a real TTY; drizzle-kit's prompt never gets answered.

**How to apply:** Apply DB schema changes directly via SQL:
```sql
ALTER TABLE proposals ADD CONSTRAINT proposals_tender_id_unique UNIQUE (tender_id);
```
Run via the database skill's `executeSql` tool or a one-shot `node -e` script using the DB connection.
