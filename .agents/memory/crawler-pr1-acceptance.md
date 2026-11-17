---
name: PR1 acceptance bar
description: User-defined acceptance boundary and sequence for the crawler PRs.
---

PR1 is limited to reliable ingestion of real source notices and publicly available attachments, robots compliance, database persistence, crawler tests, typecheck/build, and pushing the scoped changes to the existing PR #2 while it remains draft. Do not start PR2 qualification improvements until real source content reliably enters the database.

**Why:** The user asked to keep PR1 focused on technical ingestion reliability and defer usefulness/qualification improvements to PR2.

**How to apply:** For PR1, validate actual notices and persisted extracted content rather than treating HTTP 200 as sufficient. Keep CDB inactive by default and UNDP blocked per robots.txt.
