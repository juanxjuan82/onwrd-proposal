import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractDeadline,
  extractProcurementDocuments,
  hasSubstantiveScope,
} from "./base-adapter.js";
import { CDBAdapter } from "./cdb.js";
import { CARICOMAdapter, parseCaricomListing } from "./caricom.js";
import { UNGMAdapter } from "./ungm.js";
import { evaluateCrawlerEligibility } from "../lib/crawler-eligibility.js";

const sampleTitle = "Regional public awareness campaign services";
const sampleScope = "The selected firm will design a communications strategy, develop public information materials, " +
  "coordinate stakeholder interviews, deliver a regional awareness campaign, and submit final reports.";

type MockFetch = (url: string, init?: RequestInit) => Promise<Response>;

async function withMockFetch<T>(mock: MockFetch, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = mock as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}

describe("CDB public procurement extraction", () => {
  it("extracts detail scope, deadline, notice URL, and document-status provenance", async () => {
    const listing = `<html><main><article class="views-row">
      <a href="/work-with-us/procurement/procurement-notices/schooner-vessel">
        Consultancy Services for Technical and Operational Assessment
      </a>
      <p>Dominica · Deadline Oct 23, 2026 04:00 PM</p>
    </article></main></html>`;
    const detail = `<html><nav>Home Procurement News Contact</nav><main><article>
      <h1>Consultancy Services for Technical and Operational Assessment</h1>
      <p>The selected consultancy firm will inspect the vessel, assess technical and operational
      capacity, interview the crew, review safety procedures, and deliver an assessment report with
      recommendations and implementation priorities for the regional food security programme.</p>
      <p>Deadline: October 23, 2026</p>
    </article></main><footer>Subscribe to our newsletter</footer></html>`;
    const rows = await withMockFetch(async (url) => new Response(
      url.includes("/schooner-vessel") ? detail : listing,
      { status: 200, headers: { "content-type": "text/html" } },
    ), () => new CDBAdapter().fetchOpportunities());

    assert.equal(rows.length, 1);
    assert.match(rows[0].description, /assess technical and operational capacity/);
    assert.doesNotMatch(rows[0].description, /Home Procurement News Contact|Subscribe to our newsletter/);
    assert.equal(rows[0].deadline?.toISOString().slice(0, 10), "2026-10-23");
    assert.equal(rows[0].rawData?.noticeUrl, rows[0].url);
    assert.equal(rows[0].rawData?.sourcePage, "https://www.caribank.org/work-with-us/procurement/procurement-notices");
    assert.equal(rows[0].rawData?.descriptionStatus, "substantive");
    assert.equal(rows[0].rawData?.documentStatus, "none_found");
  });

  it("does not replace missing detail with a synthetic description or navigation text", async () => {
    const listing = `<html><main><article class="views-row">
      <a href="/work-with-us/procurement/procurement-notices/short">Regional Communications RFP Notice</a>
    </article></main></html>`;
    const rows = await withMockFetch(async (url) => url.includes("/short")
      ? new Response("Unavailable", { status: 503 })
      : new Response(listing, { status: 200, headers: { "content-type": "text/html" } }),
    () => new CDBAdapter().fetchOpportunities());
    assert.equal(rows.length, 1);
    assert.equal(rows[0].description, "");
    assert.equal(rows[0].rawData?.detailFetchStatus, "fetch_failed");
    assert.equal(rows[0].rawData?.descriptionStatus, "insufficient_scope");
    assert.equal(rows[0].rawData?.needsEnrichment, true);
  });

  it("checks the live robots policy before requesting a CDB notice listing", async () => {
    const requests: string[] = [];
    await assert.rejects(
      () => withMockFetch(async (url) => {
        requests.push(new URL(url).pathname);
        return new Response("User-agent: *\nDisallow: /work-with-us/procurement/procurement-notices",
          { status: 200, headers: { "content-type": "text/plain" } });
      }, () => new CDBAdapter().fetchOpportunities()),
      /robots\.txt disallows/i,
    );
    assert.deepEqual(requests, ["/robots.txt"]);
  });
});

describe("CARICOM fixture extraction", () => {
  it("uses procurement card content only and keeps source provenance", () => {
    const html = `<main><article class="procurement-card">
      <h2><a href="/procurement-notices/communications-campaign">Regional Communications Campaign</a></h2>
      <p>Qualified firms will develop public information materials, coordinate community engagement,
      deliver social media content, and report campaign reach across CARICOM member states.
      Closing date: 30 September 2026.</p>
    </article></main>`;
    const rows = parseCaricomListing(html);
    assert.equal(rows.length, 1);
    assert.match(rows[0].description, /develop public information materials/);
    assert.equal(rows[0].deadline?.toISOString().slice(0, 10), "2026-09-30");
    assert.equal(rows[0].rawData?.noticeUrl, rows[0].url);
    assert.equal(rows[0].rawData?.descriptionStatus, "substantive");
  });

  it("qualifies a substantive communications notice for the canonical promotion path", async () => {
    const { scoreCrawlerOpportunity } = await import("./index.js");
    const opportunity = {
      title: "Caribbean public awareness campaign for small businesses",
      organization: "Caribbean Development Bank",
      country: "Caribbean",
      sector: "Communications",
      deadline: new Date("2099-10-23T00:00:00Z"),
      description: "The selected firm will develop a communications strategy, create public information " +
        "materials, conduct stakeholder interviews, manage a regional awareness campaign, and deliver " +
        "final reports and campaign metrics.",
    };
    const score = scoreCrawlerOpportunity(opportunity);
    const eligibility = evaluateCrawlerEligibility({
      title: opportunity.title,
      description: opportunity.description,
      recommendation: score.recommendation,
      deadline: opportunity.deadline,
    });
    assert.ok(score.fitScore >= 60);
    assert.equal(score.recommendation, "PURSUE");
    assert.equal(eligibility.eligible, true);
    assert.equal(eligibility.destination, "new");
  });

  it("rejects navigation-only text and keeps crawling fail-closed under robots restrictions", async () => {
    const navigation = `<main><ul><li><a href="/procurement-notices/open">Open Procurement Notices</a></li></ul></main>`;
    assert.equal(parseCaricomListing(navigation).length, 0);
    let requests = 0;
    await assert.rejects(
      () => withMockFetch(async () => { requests++; return new Response("should not fetch"); },
        () => new CARICOMAdapter().fetchOpportunities()),
      /robots\.txt disallows all notice paths/i,
    );
    assert.equal(requests, 0);
  });
});

describe("UNDP access policy", () => {
  it("never requests the procurement site while robots.txt disallows all paths", async () => {
    let requests = 0;
    await assert.rejects(
      () => withMockFetch(async () => { requests++; return new Response("should not fetch"); },
        () => new UNGMAdapter().fetchOpportunities()),
      /robots\.txt disallows all paths/i,
    );
    assert.equal(requests, 0);
  });
});

describe("deadline and procurement-document extraction", () => {
  it("parses supported date formats and rejects impossible dates", () => {
    assert.equal(extractDeadline("Deadline: 2026-10-23")?.toISOString().slice(0, 10), "2026-10-23");
    assert.equal(extractDeadline("Closing date: 30 September 2026")?.toISOString().slice(0, 10), "2026-09-30");
    assert.equal(extractDeadline("Submission deadline: 10/11/2026")?.toISOString().slice(0, 10), "2026-11-10");
    assert.equal(extractDeadline("Deadline: 31 February 2026"), undefined);
    assert.equal(extractDeadline("Published: October 23, 2026"), undefined);
    assert.equal(extractDeadline("Submission date: October 23, 2026"), undefined);
  });

  it("extracts bounded PDF text and preserves the public document URL", async () => {
    const text = "Terms of reference specify stakeholder interviews, communications materials, " +
      "field consultations, campaign delivery, and a final reporting workshop.";
    const docs = await extractProcurementDocuments(
      `<article><a href="/files/terms-of-reference.pdf">Terms of Reference</a></article>`,
      "https://www.caribank.org/notice/1",
      ["caribank.org"],
      async () => ({ response: new Response(null, { status: 200, headers: { "content-type": "application/pdf" } }), bytes: Buffer.from("fixture") }),
      async () => text,
    );
    assert.equal(docs[0].status, "extracted");
    assert.equal(docs[0].url, "https://www.caribank.org/files/terms-of-reference.pdf");
    assert.match(docs[0].extractedText ?? "", /stakeholder interviews/);
    assert.ok(docs[0].characters <= 12_000);
  });

  it("distinguishes missing, malformed, textless, and unsupported attachments", async () => {
    const html = `<article>
      <a href="/files/terms-of-reference.pdf">Terms of Reference</a>
      <a href="/files/terms-of-reference.doc">Terms of Reference DOC</a>
    </article>`;
    const missing = await extractProcurementDocuments(
      html, "https://www.caribank.org/notice/1", ["caribank.org"],
      async () => ({ response: new Response("missing", { status: 404 }), bytes: Buffer.alloc(0) }),
    );
    assert.equal(missing.find((doc) => doc.format === "pdf")?.status, "fetch_failed");
    assert.equal(missing.find((doc) => doc.format === "unsupported")?.status, "unsupported");

    const malformed = await extractProcurementDocuments(
      `<article><a href="/files/terms-of-reference.pdf">Terms of Reference</a></article>`,
      "https://www.caribank.org/notice/1",
      ["caribank.org"],
      async () => ({ response: new Response(null, { status: 200 }), bytes: Buffer.from("not a PDF") }),
      async () => { throw new Error("malformed PDF fixture"); },
    );
    assert.equal(malformed[0].status, "malformed");
    assert.equal(malformed[0].extractedText, undefined);

    const textless = await extractProcurementDocuments(
      `<article><a href="/files/terms-of-reference.pdf">Terms of Reference</a></article>`,
      "https://www.caribank.org/notice/1",
      ["caribank.org"],
      async () => ({ response: new Response(null, { status: 200 }), bytes: Buffer.from("scanned PDF") }),
      async () => "",
    );
    assert.equal(textless[0].status, "scanned_or_textless");
    assert.equal(textless[0].extractedText, undefined);
  });

  it("requires genuine scope beyond repeating the title", () => {
    assert.equal(hasSubstantiveScope(`${sampleTitle} ${sampleScope}`, sampleTitle), true);
    assert.equal(hasSubstantiveScope("Home About Procurement Notices Contact us", "Procurement Notices"), false);
    assert.equal(hasSubstantiveScope(`CARICOM Secretariat procurement notice: ${sampleTitle}`, sampleTitle), false);
  });
});
