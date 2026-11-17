---
name: PDF extraction test seam
description: How to test procurement PDF handling without fragile synthetic PDF binaries.
---

Unit tests for procurement-document extraction should inject the bounded byte-fetcher and PDF text parser. Use them to verify extracted, textless/scanned, missing, malformed, and failed states without relying on handwritten PDF bytes; validate the actual `pdf-parse` integration against an approved public document.

**Why:** Hand-built minimal PDFs can be structurally malformed and may fail asynchronously in the parser, obscuring whether the extraction pipeline handles the state correctly.

**How to apply:** Keep parser behavior behind the existing injection seam in tests. For live checks, fetch only public, source-approved attachments and do not run OCR automatically.
