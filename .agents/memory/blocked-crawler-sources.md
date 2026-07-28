---
name: Blocked crawler sources from Replit
description: Which procurement sources are permanently blocked from Replit's environment and why, as of July 2026.
---

The following sources were deactivated (active=false in tender_sources) because they consistently fail from Replit's shared IP range:

| Source | DB id | Failure type | Notes |
|--------|-------|-------------|-------|
| IDB (iadb.org) | 3 | HTTP 403 | iadb.org blocks server-to-server requests; had 30/81 failures |
| CDB (caribank.org) | 4 | HTTP 404 | Site restructured, all known paths return 404 |
| CTO (caribtourism.com) | 6 | Connection timeout | Site unreachable from Replit |
| EU Caribbean/CARIFORUM (cariforum.org) | 8 | Connection timeout | Site unreachable from Replit |

TED Europa (`ted.europa.eu/api/v3.0`) was considered as replacement but returns `HTTP 202` with `x-amzn-waf-action: challenge` — AWS CloudFront WAF is intercepting all requests from Replit.

All other alternatives probed and blocked:
- PAHO, OAS, OECS: 403/404
- WFP procurement, UNICEF supply: 000 (timeout)
- Caribbean government procurement portals (Barbados, Jamaica, Trinidad, Bahamas eProcurement): all 000 (timeout)
- UNGM REST API: 500
- data.iadb.org: returns `{"version":1}` only, no procurement data exposed

**Active sources as of July 2026**: World Bank (1), UNGM (2), Bahamas Gov (5), CARICOM (7).

**Why the deactivations matter**: Each blocked source was generating 30 `failed` crawler_run records per batch (same error every time), inflating `per_source_errors` in every crawl batch with known-unfixable failures.
