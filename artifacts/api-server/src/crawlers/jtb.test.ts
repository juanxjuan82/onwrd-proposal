import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BELIZE_TOURISM_FEED, JTBAdapter, selectFeedAdverts, selectFeedPosts, selectJtbAdverts } from "./jtb.js";

const bucket = "https://lcms-mysql-server.s3.us-east-2.amazonaws.com/jtbonline.org/wp-content/uploads";
const item = (id: number, title: string, file: string, extra: Record<string, unknown> = {}) => ({
  id,
  date: "2026-11-13T20:46:01",
  mime_type: "application/pdf",
  source_url: `${bucket}/${file}`,
  title: { rendered: title },
  ...extra,
});

describe("Jamaica Tourist Board adapter — choosing adverts from the media feed", () => {
  it("keeps tender PDFs and ignores reports, images, withdrawals and duplicates", () => {
    const adverts = selectJtbAdverts([
      item(1, "PR UK &#8211; EOI 2025 &#8211; Final", "20250205154103/PR-UK-EOI-2025-Final.pdf", { date: "2025-02-05T15:41:03" }),
      item(2, "RFP Ad Data Verification System", "20261113204601/RFP-Ad-Data-Verification-System.pdf"),
      item(2, "RFP Ad Data Verification System", "20261113204601/RFP-Ad-Data-Verification-System.pdf"),
      item(3, "Monthly Statistical Report August 2023", "Monthly-Statistical-Report.pdf"),
      item(4, "EOI website Ad.", "EOI-website-Ad.jpg", { mime_type: "image/jpeg" }),
      item(5, "EOI_Advertising_Agencies_AdveRT-Withdrawal", "EOI-Withdrawal.pdf"),
    ]);
    assert.deepEqual(adverts.map((advert) => advert.title), [
      "RFP Ad Data Verification System",
      "PR UK – EOI 2025 – Final",
    ]);
    assert.equal(adverts[0].postedAt?.toISOString().slice(0, 10), "2026-11-13");
  });

  it("only accepts files in the JTB's own folder or site", () => {
    const adverts = selectJtbAdverts([
      item(1, "RFP One", "x.pdf", { source_url: "https://lcms-mysql-server.s3.us-east-2.amazonaws.com/another-site/rfp.pdf" }),
      item(2, "RFP Two", "x.pdf", { source_url: "https://evil.example.com/jtbonline.org/wp-content/uploads/rfp.pdf" }),
      item(3, "RFP Three", "x.pdf", { source_url: "http://www.jtbonline.org/wp-content/uploads/rfp.pdf" }),
      item(4, "RFP Four", "x.pdf", { source_url: "https://www.jtbonline.org/wp-content/uploads/rfp.pdf" }),
    ]);
    assert.deepEqual(adverts.map((advert) => advert.id), [4]);
  });
});

describe("Belize Tourism Board — news posts and documents", () => {
  it("keeps tender posts on the board's own site and reads their text", () => {
    const post = (id: number, title: string, link: string) => ({
      id, date: "2026-11-10T09:00:00", link, title: { rendered: title },
      content: { rendered: "<p>The Belize Tourism Board invites firms to provide marketing representation and public relations services.</p>" },
    });
    const posts = selectFeedPosts([
      post(1, "Request for Expression of Interest Marketing Representation Services in Mexico", "https://www.belizetourismboard.org/request-mexico/"),
      post(2, "BTB Announces Winners of Photography Sweepstake", "https://www.belizetourismboard.org/winners/"),
      post(3, "Request for Proposals: Elsewhere", "https://example.com/rfp/"),
    ], BELIZE_TOURISM_FEED);
    assert.deepEqual(posts.map((item) => item.id), [1]);
    assert.match(posts[0].text, /marketing representation and public relations/);
    assert.equal(posts[0].postedAt?.toISOString().slice(0, 10), "2026-11-10");
  });

  it("accepts documents only from the board's own site", () => {
    const adverts = selectFeedAdverts([
      item(1, "RFP Destination Branding", "x.pdf", { source_url: "https://www.belizetourismboard.org/wp-content/uploads/2026/11/rfp.pdf" }),
      item(2, "RFP Elsewhere", "x.pdf"),
    ], BELIZE_TOURISM_FEED);
    assert.deepEqual(adverts.map((advert) => advert.id), [1]);
  });
});

describe("Jamaica Tourist Board adapter — crawl rules", () => {
  const withFetch = async <T>(mock: (url: string) => Response, run: () => Promise<T>): Promise<T> => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => mock(String(input))) as typeof fetch;
    try { return await run(); } finally { globalThis.fetch = original; }
  };

  it("does not query the feed when robots.txt disallows it", async () => {
    const requested: string[] = [];
    await assert.rejects(() => withFetch((url) => {
      requested.push(url);
      return new Response("User-agent: *\nDisallow: /wp-json/", { status: 200, headers: { "content-type": "text/plain" } });
    }, () => new JTBAdapter(0).fetchOpportunities()), /disallows the media feed/i);
    assert.deepEqual(requested, ["https://www.jtbonline.org/robots.txt"]);
  });

  it("searches recent PDFs only and returns nothing when the feed has no tender adverts", async () => {
    const requested: string[] = [];
    const results = await withFetch((url) => {
      requested.push(url);
      if (url.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nDisallow: /wp-admin/", { status: 200, headers: { "content-type": "text/plain" } });
      }
      return new Response(JSON.stringify([item(3, "Monthly Statistical Report", "report.pdf")]), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }, () => new JTBAdapter(0).fetchOpportunities());
    assert.deepEqual(results, []);
    const searches = requested.filter((url) => url.includes("/wp-json/wp/v2/media"));
    assert.ok(searches.length >= 5);
    assert.ok(searches.every((url) => url.includes("mime_type=application/pdf") && /[?&]after=20\d\d-/.test(url)));
  });

  it("is registered in the admin catalog", async () => {
    process.env.DATABASE_URL ??= "postgres://x:x@localhost/x";
    const { validateSourceConfiguration } = await import("./index.js");
    const validated = validateSourceConfiguration({
      adapterType: "jtb", url: "https://www.jtbonline.org/public-offerings/procurement/",
    });
    assert.ok(!("error" in validated));
    const belize = validateSourceConfiguration({ adapterType: "belize_tourism", url: "https://www.belizetourismboard.org/" });
    assert.ok(!("error" in belize));
  });
});
