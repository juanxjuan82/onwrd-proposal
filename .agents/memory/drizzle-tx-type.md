---
name: Drizzle tx type annotation
description: How to properly type the tx parameter inside db.transaction() callbacks to avoid TS7006 implicit-any errors
---

TypeScript cannot infer the `tx` parameter type in `db.transaction(async (tx) => {...})` in this project (likely because the db object type isn't fully resolved at typecheck time). Add the `DbTx` type alias locally to avoid `TS7006: Parameter 'tx' implicitly has an 'any' type`.

## Rule

Define the type alias inline inside the handler function, then annotate the callback param:

```typescript
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
await db.transaction(async (tx: DbTx) => {
  // tx.execute(), tx.insert(), tx.update() all work correctly
});
```

**Why:** The `db` object is typed but Drizzle's `transaction` overloads don't resolve cleanly through tsc in this monorepo. The `Parameters<...>` pattern extracts the correct transaction type without importing internal Drizzle types.

**How to apply:** Add the `type DbTx` alias at the top of any function that calls `db.transaction`. The pattern is already used in `apply-deterministic-score.ts`, `promote-discovered-tender.ts`, `opportunities.ts` (pursue), and `proposals.ts` (intake).
