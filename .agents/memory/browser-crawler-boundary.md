---
name: Browser crawler security boundary
description: Durable safety rules for optional browser-backed tender enrichment
---

Browser rendering is an opt-in fallback for explicitly approved HTML sources, never a replacement for structured APIs or direct detail fetching.

**Why:** Browser services expand the network boundary. Validating a redirect after fetching it, accepting broad parent suffixes, or using generic listing text as detail scope can create SSRF exposure and false opportunities.

**How to apply:** Validate the initial URL and every redirect before network access; allow only the source host/root tree; require server-version attestation; cap time and bytes through body consumption; require detail-specific genuine content before emitting a rendered-listing record; keep the path zero-AI.