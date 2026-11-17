---
name: Generation recovery fencing
description: Correctness rules for recovering abandoned multi-phase proposal generation without racing a live or retried worker.
---

Every generation attempt must have persisted ownership that is refreshed while active. Recovery clears that ownership, and every later phase write—including intermediate requirements and strategy writes—must prove it still owns the attempt.

Proposal and linked-tender terminal transitions must happen in one transaction, conditional on the same ownership token.

**Why:** A stale timestamp alone cannot distinguish an abandoned job from a slow live call. Without fencing, an old worker can overwrite a manual retry; without an atomic cross-record transition, an old failure can reset the tender after a retry has already claimed the proposal.

**How to apply:** Any new background generation phase or recovery path must heartbeat the active attempt, reject superseded writes, and update proposal/tender state together when completing or failing.