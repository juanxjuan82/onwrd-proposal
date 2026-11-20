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

As checked on 2026-11-17 (from a different network than Replit):
- OECS (`www.oecs.int/en/work-with-us/procurements/current-tenders`): robots.txt permits the listing and it returns titles, but every tender document (`.../download`, `.../viewdocument/`) redirects to a login page. Titles only, no scope — not worth an adapter unless an account/feed is arranged.
- Bahamas e-procurement (`bahamas.bonfirehub.com`): robots.txt is `Disallow: /`. Do not crawl.

**External IDs:** build them with `stableExternalId()` in `crawlers/dedup.ts` (full hash of the notice URL). Never truncate an encoded URL/title — a 16-char base64 slice keeps only 12 characters (`https://www.`), and the crawl loop treats a matching externalId as an existing record, so later notices were dropped as duplicates.

As checked on 2026-11-20 (live runs of every unblocked adapter):
- **World Bank API filters:** `q=` and `fq=` do NOT filter — they return the newest notices worldwide (the source of the Rwanda/Kyrgyz junk). What works: `project_ctry_name_exact=A^B` (exact names, `^` = OR; e.g. `St. Lucia`, `OECS Countries`, `Caribbean`), `notice_type_exact=A^B`, and `qterm="phrase"`. Use `bid_description` as the title (the contract); `project_name` is only the umbrella programme.
- **Bahamas gov tender page is an archive:** 27 rows, nearly all 2022–2024, newest due date Jan 2026. Zero live tenders is the correct result today. The adapter drops expired rows, undated rows whose document upload stamp (`-YYYYMMDDhhmmss.pdf`) is over 180 days old, contract awards, job posts and links to other organisations' portals.
- **CDB and CARICOM are small:** 8 and 3 open notices in total, all engineering/works on this date. Low volume there is the source, not a crawler fault.
- **Scoring:** a recommendation above SKIP requires a named ONWRD service phrase (`findCoreServicePhrases`); loose words such as "communications" in notice boilerplate previously scored sewage and tariff notices as PURSUE.

**New listing-page sources (added 2026-11-20, config in `crawlers/listing-adapter.ts`):** `bermuda_gov` (gov.bm/procurement-notices, no robots.txt published, 10 open notices), `central_bank_bahamas` (public-procurement news list), `compete_caribbean` (opportunities, 0 open on this date), `ccreee` (all-procurements, all expired on this date). One shared `ListingAdapter`; adding a similar site is a config entry. Seeded inactive like every new source.

Checked and rejected on the same date:
- GOJEP (Jamaica e-procurement): search is behind a CAPTCHA — do not automate.
- UNGM: HTTP 403 to automated requests. IDB: still 403.
- TED (EU) API works but has almost no open Caribbean notices.
- Caribbean Export tenders page and Jamaica Tourist Board procurement table are filled in by JavaScript; plain fetch sees no notices. JTB posts marketing/PR agency RFPs as PDFs, so it is worth a browser-rendered adapter later.
- CDEMA and CARPHA "opportunities" are mostly staff vacancies.
- Not reachable from the test network: caribbeanclimate.bz, nassaulpia.com, caribtourism.com / onecaribbean.org.
