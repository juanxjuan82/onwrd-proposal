---
name: Crawler source availability
description: Source-access constraints and validation notes; external availability can change.
---

As checked on 2026-10-19:

| Source | DB id | Failure type | Notes |
|--------|-------|-------------|-------|
| IDB (iadb.org) | 3 | HTTP 403 | iadb.org blocks server-to-server requests; had 30/81 failures |
| CDB (caribank.org) | 4 | Previously HTTP 404 | The public `/work-with-us/procurement/procurement-notices` page and a linked notice returned HTTP 200; robots.txt permits the path. Keep inactive by default pending a controlled pilot. |
| CARICOM (caricom.org) | — | Public listing accessible | On 2026-10-19, robots.txt allowed `/procurement-notices/`, `/procurement/`, and `/wp-content/uploads/`. The listing returned HTTP 200 and showed seven open notices; keep inactive pending a successful configuration-versioned pilot. |
| CTO (caribtourism.com) | 6 | Connection timeout | Site unreachable from Replit |
| EU Caribbean/CARIFORUM (cariforum.org) | 8 | Connection timeout | Site unreachable from Replit |
| UNDP procurement notices (`procurement-notices.undp.org`) | 2 | robots.txt disallows all | Do not crawl unless an authorized feed or explicit permission becomes available. |

TED Europa (`ted.europa.eu/api/v3.0`) was considered as replacement but returns `HTTP 202` with `x-amzn-waf-action: challenge` — AWS CloudFront WAF is intercepting all requests from Replit.

Other alternatives previously probed and blocked:
- PAHO, OAS, OECS: 403/404
- WFP procurement, UNICEF supply: 000 (timeout)
- Caribbean government procurement portals (Barbados, Jamaica, Trinidad, Bahamas eProcurement): all 000 (timeout)
- UNGM REST API: 500
- data.iadb.org: returns `{"version":1}` only, no procurement data exposed

**Why these constraints matter:** Repeatedly crawling inaccessible sources creates noisy failure records, while crawling paths disallowed by robots.txt violates the source's published access rules. CARICOM's procurement paths are currently permitted, but its source still requires a controlled pilot before activation.

**How to apply:** Recheck robots.txt and the exact public notice path before each source reactivation. Keep CDB and CARICOM disabled until a controlled pilot validates useful extraction; never bypass UNDP's site-wide disallow rule.
