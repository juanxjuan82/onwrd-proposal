---
name: Deterministic metadata extractor
description: Tender imports use extractTenderMetadata() (no AI); returns needsReview flag when title/agency undetected.
---

# Deterministic metadata extractor

## Rule
Manual tender imports (`POST /tenders/manual`, `POST /tenders/extract-text`, `POST /opportunities/.../import`) must use `extractTenderMetadata(text)` from `src/lib/metadata-extractor.ts` — **not** an AI call.

**Why:** Import paths were the last place where AI was triggered automatically (without user intent). Moving to a deterministic parser eliminates surprise AI usage and quota consumption on every paste/upload.

## How to apply
- `extractTenderMetadata(text: string): ExtractedTenderMetadata` — pass up to 8000 chars.
- Returns `{ title, agency, description, category, deadline, valueAmount, contactInfo, needsReview }`.
- When `needsReview` is true, title and/or agency could not be detected; save with a placeholder and surface the flag to the user (follow-up task #16 covers the UI side).
- Do NOT pass more than 8000 chars; the parser only needs the document header/preamble.
