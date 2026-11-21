import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LISTING_SOURCES,
  ListingAdapter,
  getListingSource,
  listingRejection,
  parseListingPage,
  readListingDeadline,
} from "./listing-adapter.js";

const source = (adapterType: string) => {
  const config = getListingSource(adapterType);
  assert.ok(config, `${adapterType} must be registered`);
  return config;
};

describe("listing sources — date wording", () => {
  it("reads the deadline wordings the sources use", () => {
    assert.equal(readListingDeadline("Issued 30 October 2026 Closes 27 November 2026")?.toISOString().slice(0, 10), "2026-11-27");
    assert.equal(readListingDeadline("Deadline: Monday, Nov 16, 2026 The Centre invites")?.toISOString().slice(0, 10), "2026-11-16");
    assert.equal(readListingDeadline("Closes: October 19, 2026")?.toISOString().slice(0, 10), "2026-10-19");
    assert.equal(readListingDeadline("No date here"), undefined);
  });
});

describe("listing sources — page parsing", () => {
  it("Bermuda: one notice per result card with its own closing date", () => {
    const card = (slug: string, title: string, closes: string) => `
      <h3 class="public-procurement-result-title"><a href="/procurement-notices/${slug}" class="card-link">${title}</a></h3>
      <div class="public-procurement-result-details"><span><svg><line x1="4"/></svg> <span>REF-1</span></span>
      <span>Issued 02 October 2026</span><span>Closes ${closes}</span></div>`;
    const html = `<a href="/procurement-notices">Procurement Notices</a>
      ${card("tourism-marketing-services", "Tourism Marketing Services", "27 November 2026")}
      ${card("bus-shelter", "Supply of a Modular Bus Shelter", "08 December 2026")}<footer></footer>`;
    const rows = parseListingPage(html, "https://www.gov.bm/procurement-notices", source("bermuda_gov"));
    assert.deepEqual(rows.map((row) => row.url), [
      "https://www.gov.bm/procurement-notices/tourism-marketing-services",
      "https://www.gov.bm/procurement-notices/bus-shelter",
    ]);
    assert.equal(rows[0].title, "Tourism Marketing Services");
    assert.equal(rows[0].deadline?.toISOString().slice(0, 10), "2026-11-27");
    assert.equal(rows[1].deadline?.toISOString().slice(0, 10), "2026-12-08");
    assert.equal(rows[0].postedAt?.toISOString().slice(0, 10), "2026-10-02");
  });

  it("Compete Caribbean: skips closed calls and vacancies", () => {
    const card = (state: string, group: string, slug: string, title: string) => `
      <article class="cc-card"><div class="cc-card__body"><p class="cc-card__meta">
      <span class="cc-opp-state cc-opp-state--${state}">${state}</span> <span class="cc-card__group">${group}</span></p>
      <h2 class="cc-card__title"><a href="https://www.competecaribbean.org/opportunities/${slug}/">${title}</a></h2>
      <p class="cc-card__facts"><strong>Closes:</strong>&nbsp;December 19, 2026</p></div></article>`;
    const html = card("open", "Consultancy", "branding-firm", "Consulting Firm: Destination Branding Strategy") +
      card("closed", "Consultancy", "old-call", "Consulting Firm: Old Closed Call") +
      card("open", "Vacancy", "officer", "Vacancy: Programme Officer Position");
    const rows = parseListingPage(html, "https://www.competecaribbean.org/opportunities/?state=open", source("compete_caribbean"));
    assert.deepEqual(rows.map((row) => row.title), ["Consulting Firm: Destination Branding Strategy"]);
    assert.equal(rows[0].deadline?.toISOString().slice(0, 10), "2026-12-19");
  });

  it("CCREEE: names the notice from its heading link, not the 'Read more' link", () => {
    const html = `<section> <div class="inside"> <h4><strong><a href="https://www.ccreee.org/procurements/rfp-comms/" title="x">Request for Proposals: Communications &#8211; Campaign</strong></a></h4>
      <p><span>Deadline:</span> Monday, Dec 14, 2026</p><p>The Centre invites firms...</p>
      <a href="https://www.ccreee.org/procurements/rfp-comms/">Read more</a> </div> </section>`;
    const rows = parseListingPage(html, "https://www.ccreee.org/all-procurements/", source("ccreee"));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, "Request for Proposals: Communications – Campaign");
    assert.equal(rows[0].deadline?.toISOString().slice(0, 10), "2026-12-14");
  });

  it("Central Bank of The Bahamas: reads the posted date and skips award announcements", () => {
    const item = (day: string, slug: string, title: string) => `
      <div class="date-w"> <div class="date-info"> <span class="day d-block">${day}</span> <span class="month d-block">Oct</span> <span class="year d-block">2026</span> </div> </div>
      <div class="content-w"> <h2 class="title"> <a href="https://www.centralbankbahamas.com/news/public-procurement/${slug}" title="${title}" class="link"> ${title} </a> </h2>`;
    const html = item("30", "rfp-public-relations", "Request for Proposal: Public Relations Services") +
      item("12", "award-1", "2026 Award Announcement: Security Services");
    const rows = parseListingPage(html, "https://www.centralbankbahamas.com/news/public-procurement", source("central_bank_bahamas"));
    assert.deepEqual(rows.map((row) => row.title), ["Request for Proposal: Public Relations Services"]);
    assert.equal(rows[0].postedAt?.toISOString().slice(0, 10), "2026-10-30");
  });
});

describe("listing sources — tourism board and government pages added later", () => {
  it("Bermuda Tourism Authority: each RFP document link is a notice, dated by its folder", () => {
    const html = `<main><p>The BTA uses an RFP process.</p>
      <a href="https://www.gotobermuda.com/sites/default/files/2026-11/bta_public_relations_rfp.pdf">View the Public Relations Agency RFP</a>
      <a href="https://www.gotobermuda.com/meetings-groups/meetings-rfp">Click Here to Submit a Meetings RFP</a></main>`;
    const rows = parseListingPage(html, "https://www.gotobermuda.com/bta/rfp", source("bermuda_tourism"));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, "Public Relations Agency RFP");
    assert.equal(rows[0].postedAt?.toISOString().slice(0, 10), "2026-11-01");
  });

  it("Turks and Caicos: reads the closing date written into the notice title", () => {
    const html = `<tr class="cat-list-row0" > <th class="list-title" scope="row">
      <a href="/publicservice/government-tenders/tender-notice-tr-26-30-destination-marketing">
      TENDER NOTICE: TR 26/30, DESTINATION MARKETING SERVICES; Closing: Wednesday, 9 December 2026 at 10:00 A.M. </a> </th> </tr>`;
    const rows = parseListingPage(html, "https://gov.tc/publicservice/government-tenders", source("turks_caicos_gov"));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].url, "https://gov.tc/publicservice/government-tenders/tender-notice-tr-26-30-destination-marketing");
    assert.equal(rows[0].deadline?.toISOString().slice(0, 10), "2026-12-09");
  });

  it("Belize portal: reads its deadline wording and skips rows marked Expired", () => {
    const row = (id: number, slug: string, title: string) => `<tr id="post-row-${id}" class="post-row"><td><a href="https://procurement.gov.bz/${slug}/">${title}</a></td>
      <td><p>Belize Tourism Board<br /> Deadline December 30th ,2026; 10:00 AM (Local Belize Time)</p></td>
      <td data-sort="2026-11-18">November 18, 2026</td><td><a href="https://procurement.gov.bz/category/all-notices/consulting-services/">Consulting Services</a></td></tr>`;
    const html = row(1, "btb-marketing-agency", "BTB &#8211; Marketing Agency Services") +
      row(2, "old-notice", "Expired: 2026-11-10 10:00am Old Notice Title");
    const rows = parseListingPage(html, "https://procurement.gov.bz/opportunities/", source("belize_gov"));
    assert.deepEqual(rows.map((item) => item.title), ["BTB – Marketing Agency Services"]);
    assert.equal(rows[0].deadline?.toISOString().slice(0, 10), "2026-12-30");
  });
});

describe("listing sources — which notices are kept", () => {
  const now = new Date("2026-11-20T12:00:00Z");
  it("drops expired notices and long-undated ones, keeps the rest", () => {
    const config = { maxUndatedAgeDays: 120 };
    assert.equal(listingRejection({ deadline: new Date("2026-11-16T00:00:00Z") }, config, now), "expired");
    assert.equal(listingRejection({ deadline: new Date("2026-11-20T00:00:00Z") }, config, now), null);
    assert.equal(listingRejection({ postedAt: new Date("2026-06-01T00:00:00Z") }, config, now), "stale_undated");
    assert.equal(listingRejection({ postedAt: new Date("2026-10-30T00:00:00Z") }, config, now), null);
    assert.equal(listingRejection({}, config, now), null);
  });
});

describe("listing sources — robots.txt and registration", () => {
  const withFetch = async <T>(mock: (url: string) => Response, run: () => Promise<T>): Promise<T> => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => mock(String(input))) as typeof fetch;
    try { return await run(); } finally { globalThis.fetch = original; }
  };

  it("refuses to crawl when robots.txt disallows the listing", async () => {
    const requested: string[] = [];
    await assert.rejects(() => withFetch((url) => {
      requested.push(url);
      return new Response("User-agent: *\nDisallow: /", { status: 200, headers: { "content-type": "text/plain" } });
    }, () => new ListingAdapter(source("ccreee"), 0).fetchOpportunities()), /no listing page could be read/i);
    assert.deepEqual(requested, ["https://www.ccreee.org/robots.txt"]);
  });

  it("refuses to crawl when robots.txt cannot be verified", async () => {
    await assert.rejects(() => withFetch(() => new Response("blocked", { status: 403 }),
      () => new ListingAdapter(source("ccreee"), 0).fetchOpportunities()), /robots\.txt could not be verified/i);
  });

  it("treats a missing robots.txt as no restrictions and returns open notices with their scope", async () => {
    const future = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
    const closes = `${future.getUTCDate()} ${future.toLocaleString("en-GB", { month: "long", timeZone: "UTC" })} ${future.getUTCFullYear()}`;
    const results = await withFetch((url) => {
      if (url.endsWith("/robots.txt")) return new Response("not found", { status: 404 });
      if (url.endsWith("/procurement-notices")) {
        return new Response(`<h3 class="public-procurement-result-title"><a href="/procurement-notices/pr-services">Public Relations Services</a></h3><span>Closes ${closes}</span>
          <h3 class="public-procurement-result-title"><a href="/procurement-notices/old">Expired Road Works Tender</a></h3><span>Closes 01 January 2020</span>`,
          { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response("<main><p>The Government invites agencies to provide public relations and media relations services, including a communications strategy and campaign delivery over twelve months.</p></main>",
        { status: 200, headers: { "content-type": "text/html" } });
    }, () => new ListingAdapter(source("bermuda_gov"), 0).fetchOpportunities());
    assert.equal(results.length, 1);
    assert.equal(results[0].title, "Public Relations Services");
    assert.match(results[0].description, /communications strategy/);
    assert.ok(results[0].deadline instanceof Date);
    assert.match(results[0].externalId ?? "", /^bermuda_gov-/);
  });

  it("every listing source is in the admin catalog and can be run", async () => {
    process.env.DATABASE_URL ??= "postgres://x:x@localhost/x";
    const { SOURCE_ADAPTER_CATALOG, validateSourceConfiguration } = await import("./index.js");
    for (const config of LISTING_SOURCES) {
      assert.ok(SOURCE_ADAPTER_CATALOG.some((item) => item.adapterType === config.adapterType && !item.blockedReason));
      const validated = validateSourceConfiguration({ adapterType: config.adapterType, url: config.listingUrls[0] });
      assert.ok(!("error" in validated), `${config.adapterType}: ${"error" in validated ? validated.error : ""}`);
    }
  });
});
