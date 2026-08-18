---
name: Prompt-injection defence layers
description: How untrusted RFP/tender text must be handled at AI call sites and ingestion paths
---
Rule: EVERY tender/proposal-derived field is untrusted — title, agency, category, clientName, industry, contactInfo, sourceUrl, descriptions, raw text, and AI-derived strategy notes — not just the document body. Wrap all of it inside the untrusted boundary at every AI call site; only application-controlled constants stay outside.

**Why:** metadata interpolated outside the boundary is a concrete injection bypass — the safety policy only protects tagged content.

**How to apply:**
- New AI call site → wrap all derived text with the shared prompt-safety helpers and include the untrusted-content policy in the system message.
- New tender ingestion path → compute the injection warning over every stored derived field.
- Partial updates → merge persisted values before re-scanning so an untouched malicious field can't silently clear the flag.
- Any write to proposal content (including error/fallback writes) → re-scan banned phrases so review flags never go stale. Never strip flagged text silently; surface it for human review.
