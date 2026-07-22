---
name: Drizzle tx.execute quirks (node-postgres driver)
description: Two runtime pitfalls when using raw sql`` inside db.transaction() with the node-postgres driver.
---

## Rule 1 — Result is QueryResult, not an array

`tx.execute<T>(sql`...`)` returns `{ rows: T[] }` (a QueryResult), **not** a `T[]` array.
Array-destructuring **throws** `TypeError: (intermediate value) is not iterable`.

**Wrong:**
```typescript
const [row] = await tx.execute<{ id: number }>(sql`INSERT ... RETURNING id`);
```

**Right:**
```typescript
const result = await tx.execute<{ id: number }>(sql`INSERT ... RETURNING id`);
const row = result.rows[0];
```

**Why:** The node-postgres adapter wraps results in `QueryResult`; postgres.js returns a plain array. Drizzle's type for `execute()` is technically `T[]` but the runtime shape depends on the driver.

**How to apply:** Every `const [x] = await tx.execute(...)` or `const [x] = await db.execute(...)` call should be rewritten to use `.rows[0]`.

---

## Rule 2 — JS arrays in sql`` become row-constructor tuples, not pg arrays

`sql\`WHERE col = ANY(${jsArray})\`` produces `col = ANY(($1, $2))` — invalid PostgreSQL.

**Wrong:**
```typescript
sql`WHERE scope = ANY(${scopes})`   // → ANY(($1,$2)) — INVALID
```

**Right:**
```typescript
const inScopes = sql.join(scopes.map(s => sql`${s}`), sql`, `);
sql`WHERE scope IN (${inScopes})`   // → IN ($1, $2) — valid
```

**Why:** Drizzle's sql template expands a JS `string[]` as individual params joined by commas inside parens — a row constructor, not a pg array literal. PostgreSQL's `ANY()` requires an actual array type, not a tuple.

**How to apply:** Replace `= ANY(${array})` with `IN (${sql.join(array.map(v => sql\`${v}\`), sql\`, \`)})`.
