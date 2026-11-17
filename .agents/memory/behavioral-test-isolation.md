---
name: behavioral test isolation
description: Keep database-backed endpoint tests independent and make concurrency tests deterministic.
---

Each behavioral test must own its database records and clean them in `finally`. For overlap tests, hold the mocked asynchronous work open until the competing request has observed the in-progress state; launching two requests with an immediately-resolving mock can let both complete successfully.

**Why:** Full API-suite load exposed a timing race in the concurrent proposal-generation test even though the test passed by itself.

**How to apply:** Use per-test records for database-backed behavior, and use an explicit promise barrier around the first request's mocked AI call before sending the second request.
