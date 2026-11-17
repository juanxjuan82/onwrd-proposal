---
name: Credential scanner heuristics
description: Durable rationale for detecting invented client citations in proposal content
---
**Rule:** treat "which organisations does this credentials text cite?" as a structure problem, not a capitalisation problem.

**Why:** capitalisation-only heuristics fail both ways — they miss one-word/acronym invented clients (sentence starts, headings, list labels) and false-positive on title-cased service phrases; because the gate is a hard block, false positives make legitimate work unexportable and false negatives defeat the protection.

**How to apply:**
- Treat section structure as a boundary, but retain client subheadings as credential content.
- Only approved case-study material can validate a client citation; other knowledge must not.
- Match an extracted client only when its normalized full title equals an approved title; partial or renamed variants are unverified.
- Re-evaluate citations before export so a changed source-of-truth cannot leave a stale approval.
