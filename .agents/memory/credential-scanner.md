---
name: Credential scanner heuristics
description: Durable rationale for detecting invented client citations in proposal content
---
**Rule:** treat "which organisations does this credentials text cite?" as a structure problem, not a capitalisation problem.

**Why:** capitalisation-only heuristics fail both ways — they miss one-word/acronym invented clients (sentence starts, headings, list labels) and false-positive on title-cased service phrases; because the gate is a hard block, false positives make legitimate work unexportable and false negatives defeat the protection.

**How to apply:**
- Punctuation and heading structure are boundaries; sub-headings inside a credentials section are content (clients are often named as sub-headings) and must be scanned.
- Only approved case-study documents count as citable credentials; other approved doc types don't sanitise a citation.
- Allowlist matching must be one-directional (candidate contained in an allowed phrase), never the reverse.
- Every path that writes proposal content must recompute the credential flag in the same write, and export gates must run before any completed/legacy early return — reviewers rejected the work repeatedly for paths that skipped either.
