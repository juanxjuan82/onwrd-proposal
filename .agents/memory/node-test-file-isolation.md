---
name: node:test file-level isolation
description: How to scope before/after/afterEach hooks to a single test file when node:test runs multiple files in the same process.
---

## The problem

When `node --test file1.ts file2.ts ...` runs multiple files in one process, all files share the same module instance. Top-level `before()` / `after()` / `afterEach()` calls register hooks on the **ROOT** test suite, not on the current file.

This means:
- A top-level `before()` in file2 can run at unexpected times relative to file2's own `describe` blocks.
- Module-level state (like `_circuitCache`, `_invokeAISpy`) persists across files.
- A top-level `afterEach()` may fire between tests from a different file.

## The fix

Wrap all hooks and `describe` blocks in a **file-level `describe`**:

```typescript
describe("file-name: descriptive label", () => {
  before(async () => { /* runs before all tests in THIS describe */ });
  after(async () => { /* runs after all tests in THIS describe */ });
  afterEach(async () => { /* runs after each test in THIS describe */ });

  describe("suite A", () => { ... });
  describe("suite B", () => { ... });
});
```

This scopes all hooks to the file's own describe context, regardless of how many other test files are loaded in the same process.

**Why:** In node:test, `before()` inside a `describe()` applies only to that describe's sub-tree. A top-level `before()` applies to the root test context which spans ALL files.

**How to apply:** Always wrap new test files (especially those with setup/teardown for shared resources like DB state, env vars, HTTP servers, or module-level singletons) in a single top-level `describe` that contains all hooks and nested suites.
