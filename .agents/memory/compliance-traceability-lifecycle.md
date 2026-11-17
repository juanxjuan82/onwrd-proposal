---
name: Compliance traceability lifecycle
description: Durable integrity rules for proposal requirement mappings, evidence, edits, approval, and export overrides.
---

Every extracted tender requirement must have one proposal-scoped coverage record written atomically with generated sections. Any later content rewrite invalidates mappings to the changed section; only explicit section approval resolves them again.

**Why:** Coverage is a claim about current proposal content. Leaving it covered after a manual or AI rewrite can make an unsupported mandatory requirement appear export-ready.

**How to apply:** Recompute compliance and overall review flags in the same transaction as section or mapping changes. Approval gates must start from all tender requirements and treat a missing mapping as unresolved.

Knowledge evidence must be checked against the current approved library when displayed and before approval/export. A compliance override is valid only when it is documented and newer than the issue it waives.

**Why:** A source can be unapproved, or a new requirement can be added, after an earlier clean approval. Proposal status alone cannot distinguish a current override from stale approval.

**How to apply:** Filter revoked evidence from responses, mark affected coverage for review, and compare the latest documented override with the latest unresolved requirement or coverage timestamp.