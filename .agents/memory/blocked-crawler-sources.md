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
- Caribbean Export tenders page and Jamaica Tourist Board procurement table are filled in by JavaScript; plain fetch sees no notices. (JTB is now covered a different way — see below.)
- CDEMA and CARPHA "opportunities" are mostly staff vacancies.
- Not reachable from the test network: caribbeanclimate.bz, nassaulpia.com, caribtourism.com / onecaribbean.org.

**Jamaica Tourist Board (`jtb`, added 2026-11-21):** the procurement page table is empty; every tender is a PDF advert in the public WordPress media feed (`/wp-json/wp/v2/media?search=…&mime_type=application/pdf&after=…`, permitted by robots.txt). Files live at `lcms-mysql-server.s3.us-east-2.amazonaws.com/jtbonline.org/wp-content/uploads/` — the adapter accepts that folder only. Volume is low (roughly 2–4 adverts a year) but on target: past adverts were for a global advertising agency, UK PR firm, and Latin America marketing representation, and each scores PURSUE. Deadlines are read from the PDF text.

**Tourism boards and island governments (checked 2026-11-21):**
- Added: `belize_tourism` (Belize Tourism Board — WordPress feed, same adapter as JTB; posts marketing-representation EOIs as news posts, last batch Jan 2023), `bermuda_tourism` (gotobermuda.com/bta/rfp — a page of links to RFP PDFs; past RFPs covered PR, advertising/media and social media agencies), `turks_caicos_gov` (gov.tc/publicservice/government-tenders — closing date is in each title), `belize_gov` (procurement.gov.bz/opportunities).
- Cayman Islands: Department of Tourism tenders are on `cayman.bonfirehub.com`, whose robots.txt is `Disallow: /`. Do not crawl.
- Saint Lucia `govt.lc/tenders` and `/consultancies`: the page returns "No Vacancies to display" to a plain fetch and the site publishes no robots.txt. Not added.
- Barbados Tourism Marketing Inc. and the Bahamas Ministry of Tourism have no tender page; their agency reviews are announced through press releases only.

**Leads outside the Caribbean (decided by the user 2026-11-21):** ONWRD wants 2–3 strong leads a week and is open to leads outside the Caribbean, **flagged**. The scorer no longer SKIPs a lead for being outside the region; it scores it with the lowest geography points, prefixes the reasoning with "⚠ Outside the Caribbean", and the inbox shows an "Outside Caribbean" badge and filter. US/Canada leads get `geoRegion = "north_america"` (decided by the stated country only).

**Volume sources added 2026-11-21:**
- `odwyers_rfps` — O'Dwyer's free list of open PR/marketing agency searches (odwyerpr.com/rfps/, robots.txt allows all). About 3 new a week; on the test date 9 were open and 5 passed the promotion gate. Only the list and a short public summary are read: the full RFP document is for O'Dwyer's members, so a person must get it from the issuer or a membership. Dates on the site are US month/day/year.
- `canadabuys` — the federal open-data file of all open tenders (~900 rows, 6 MB), filtered to marketing/communications titles. A few leads at any time.
- `email_alerts` — reads tender-alert emails from the Resend *receiving* mailbox using the existing `resend` SDK (`emails.receiving.list/get`) and RESEND_API_KEY. Senders must be a built-in tender platform domain or listed in the `ALERT_EMAIL_SENDERS` secret (comma-separated addresses or domains — needed for forwarded mail). Links in emails are stored, never fetched. The parser was written without real alert samples from UNGM/Bonfire/GOJEP; expect to tune it against the first real emails.
- Checked and not added: Discover Puerto Rico and Brand USA return 403 to automated requests; TTRA's RFP board had one item.
