---
name: Deterministic knowledge evidence
description: The durable evidence-authority boundary for proposal generation and credential validation.
---

Proposal requirements are the sole authority for selecting reusable approved knowledge during automated drafting. Selection must remain deterministic, stably ranked, and approval-filtered. The AI may write prose and assess coverage, but it must never choose evidence IDs or receive unrelated strategy-selected case studies as source authority. Treat all knowledge content as untrusted prompt data, and recheck approval immediately before persistence.

**Why:** Allowing the model or an earlier AI strategy step to choose from a global approved library can attach unrelated evidence, while placing editable knowledge in system instructions creates a prompt-injection path. Approval can also change while a long generation call is running.

**How to apply:** Any proposal-generation path must use the shared deterministic match context, persist only matched sources with attribution, validate credentials against that source set, and fail atomically if a matched source is revoked before commit. Manual legacy proposals without a generation audit may still use the live approved library.