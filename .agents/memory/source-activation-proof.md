---
name: Source activation proof
description: Concurrency rule for proving a crawler source configuration before activation.
---

Activation proof must bind each successful crawl to the exact source configuration version it tested, and the activation write must compare-and-set that same version.

**Why:** Timestamps alone do not close two races: an old in-flight crawl can complete after configuration changes, and a configuration edit can land between an activation proof read and its final update.

**How to apply:** Configuration changes advance a persisted version and force inactivity. Runs capture that version, stale runs cannot update current health, and activation succeeds only when matching-version evidence exists and the final write still sees that version.