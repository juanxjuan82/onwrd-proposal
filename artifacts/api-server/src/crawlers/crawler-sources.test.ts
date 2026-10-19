/**
 * Crawler source behavioral tests.
 *
 * Tests:
 *  (1) Each adapter (blocked + active) throws when ALL HTTP requests fail —
 *      the crawler pipeline then records a "failed" source run instead of
 *      silently recording a zero-result success.
 *  (2) Blocked adapters succeed (return empty array) when the site responds
 *      with valid-but-empty HTML — proving the throw only fires on TOTAL failure.
 *  (3) seedDefaultSources always enforces active=false for blocked adapter types
 *      (structural check that the UPDATE is present for the upgrade-path case).
 *  (4) World Bank adapter uses submission_deadline_date and filters expired items.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ── Mock fetch helper ─────────────────────────────────────────────────────────

type MockFetchFn = (url: string, init?: RequestInit) => Promise<Response>;

async function withMockFetch<T>(mockFn: MockFetchFn, fn: () => Promise<T>): Promise<T> {
  const original = global.fetch;
  (global as unknown as { fetch: MockFetchFn }).fetch = mockFn;
  try {
    return await fn();
  } finally {
    global.fetch = original;
  }
}

describe("base adapter detail quality", () => {
  it("refreshes only incomplete unpromoted discoveries and recomputes profile scores", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const guard = source.indexOf("if (existingWasIncomplete && richer && !existing.opportunityId)");
    assert.notEqual(guard, -1, "canonical opportunities must not be overwritten by crawler refreshes");
    const update = source.slice(guard, source.indexOf("const eligibility", guard));
    assert.match(update, /profileMatchesOpportunity/);
    assert.match(update, /fitScore: refreshedScore\.fitScore/);
    assert.doesNotMatch(update, /\btitle:\s*opp\.title/);
    assert.doesNotMatch(update, /\borganization:\s*opp\.organization/);
  });

  it("extracts PDF scope, deduplicates links, and records document provenance", async () => {
    const { extractProcurementDocuments } = await import("./base-adapter.js");
    const html = `<article><a href="/files/terms-of-reference.pdf">Terms of Reference</a><a href="/files/terms-of-reference.pdf">Download TOR</a></article>`;
    const documents = await extractProcurementDocuments(
      html,
      "https://example.org/notice",
      ["example.org"],
      async () => ({ response: new Response(null, { status: 200 }), bytes: Buffer.from("fixture PDF") }),
      async () => "Detailed terms of reference include stakeholder interviews, final reporting, and deliverable milestones.",
    );
    assert.equal(documents.length, 1);
    assert.equal(documents[0].status, "extracted");
    assert.match(documents[0].text ?? "", /stakeholder interviews/);
  });

  it("reports missing and malformed PDFs without inventing content or invoking OCR", async () => {
    const { extractProcurementDocuments } = await import("./base-adapter.js");
    const html = `<article><a href="/files/terms-of-reference.pdf">Terms of Reference</a></article>`;
    const missing = await extractProcurementDocuments(
      html,
      "https://example.org/notice",
      ["example.org"],
      async () => ({ response: new Response("missing", { status: 404 }), bytes: Buffer.alloc(0) }),
    );
    assert.equal(missing[0].status, "fetch_failed");
    const malformed = await extractProcurementDocuments(
      html,
      "https://example.org/notice",
      ["example.org"],
      async () => ({ response: new Response(null, { status: 200 }), bytes: Buffer.from("not a PDF") }),
      async () => { throw new Error("malformed PDF"); },
    );
    assert.equal(malformed[0].status, "malformed");
    assert.equal(malformed[0].text, undefined);
  });

  it("marks a valid PDF with no text layer for manual/OCR review instead of OCRing it", async () => {
    const { extractProcurementDocuments } = await import("./base-adapter.js");
    const documents = await extractProcurementDocuments(
      `<article><a href="/files/terms-of-reference.pdf">Terms of Reference</a></article>`,
      "https://example.org/notice",
      ["example.org"],
      async () => ({ response: new Response(null, { status: 200 }), bytes: Buffer.from("image-only PDF fixture") }),
      async () => "",
    );
    assert.equal(documents[0].status, "scanned_or_textless", JSON.stringify(documents[0]));
    assert.equal(documents[0].text, undefined);
  });

  it("leaves HTML-only notices unchanged when no procurement attachment exists", async () => {
    const { extractProcurementDocuments } = await import("./base-adapter.js");
    assert.deepEqual(
      await extractProcurementDocuments("<article><p>Notice scope is in HTML.</p></article>", "https://example.org/notice", ["example.org"]),
      [],
    );
  });

  it("resolves relative links and rejects off-domain or unsafe notice URLs", async () => {
    const { resolveNoticeUrl } = await import("./base-adapter.js");
    assert.equal(
      resolveNoticeUrl(
        "../notice/123?x=1&amp;y=2",
        "https://caricom.org/procurement-notices/2026/",
        ["caricom.org"],
      ),
      "https://caricom.org/procurement-notices/notice/123?x=1&y=2",
    );
    assert.equal(
      resolveNoticeUrl("https://external.example/notice", "https://caricom.org/", ["caricom.org"]),
      null,
    );
    assert.equal(resolveNoticeUrl("javascript:alert(1)", "https://caricom.org/"), null);
  });

  it("preserves richer genuine detail text within a bounded limit", async () => {
    const { fetchTenderDetailWithOptionalBrowser } = await import("./base-adapter.js");
    const scope = "Detailed procurement scope covering communications, outreach, delivery, and reporting. ".repeat(100);
    const result = await withMockFetch(
      async () => new Response(`<html><title>Long notice</title><main>${scope}</main></html>`, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
      () => fetchTenderDetailWithOptionalBrowser(
        "https://example.org/detail",
        "Long notice",
        { approvedDomains: ["example.org"] },
      ),
    );
    assert.ok(result);
    assert.ok(result.content.length > 1_200, "detail should be richer than legacy 1,200-character cap");
    assert.ok(result.content.length <= 4_000, "detail must remain bounded");
  });
});

const all403: MockFetchFn = async () => new Response("Forbidden", { status: 403 });
const all404: MockFetchFn = async () => new Response("Not Found", { status: 404 });
const allFail: MockFetchFn = async () => { throw new TypeError("fetch failed — connection refused"); };

/** Returns an HTML page long enough to pass the length check but with no procurement links */
const emptyHtmlPage: MockFetchFn = async () => {
  // Must be >1000 chars to pass bahamas-gov's check and >500 for others
  const padding = " ".repeat(1200);
  return new Response(
    `<html><body><p>No tenders found.${padding}</p></body></html>`,
    { status: 200, headers: { "content-type": "text/html" } },
  );
};

// ── (1) Blocked adapters — throw on total failure ─────────────────────────────

describe("IDB adapter", () => {
  it("throws when all requests return 403", async () => {
    const { IDBAdapter } = await import("./idb.js");
    const adapter = new IDBAdapter();
    await assert.rejects(
      () => withMockFetch(all403, () => adapter.fetchOpportunities()),
      (err: Error) => {
        assert.ok(err.message.includes("IDB"), `Expected error about IDB, got: ${err.message}`);
        assert.ok(err.message.includes("all"), `Expected "all" in error: ${err.message}`);
        return true;
      },
    );
  });

  it("returns empty array (not throw) when page responds but has no matching content", async () => {
    const { IDBAdapter } = await import("./idb.js");
    const adapter = new IDBAdapter();
    const results = await withMockFetch(emptyHtmlPage, () => adapter.fetchOpportunities());
    assert.deepEqual(results, []);
  });
});

describe("CDB adapter", () => {
  it("throws when all requests return 404", async () => {
    const { CDBAdapter } = await import("./cdb.js");
    const adapter = new CDBAdapter();
    await assert.rejects(
      () => withMockFetch(all404, () => adapter.fetchOpportunities()),
      (err: Error) => {
        assert.ok(err.message.includes("CDB"), `Expected error about CDB, got: ${err.message}`);
        return true;
      },
    );
  });

  it("returns empty array when page responds but has no procurement links", async () => {
    const { CDBAdapter } = await import("./cdb.js");
    const adapter = new CDBAdapter();
    const results = await withMockFetch(emptyHtmlPage, () => adapter.fetchOpportunities());
    assert.deepEqual(results, []);
  });

  it("extracts a CDB notice detail and deadline from the procurement listing", async () => {
    const mockFetch: MockFetchFn = async (url) => {
      if (url.includes("/procurement-notices/consultancy-example")) {
        return new Response(
          "<article><h1>Consultancy Example</h1><p>Qualified consultants are invited to assess " +
          "the regional programme, prepare a delivery plan, conduct stakeholder interviews, and " +
          "submit recommendations and final reports. Deadline: October 23, 2026.</p></article>",
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      return new Response(
        `<a href="/work-with-us/procurement/procurement-notices">Procurement Notices</a><table><tbody><tr><td><a href="/work-with-us/procurement/procurement-notices/consultancy-example">Consultancy Example</a></td><td>Consultancy</td><td>October 23, 2026</td></tr></tbody></table>${" ".repeat(600)}`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    };
    const { CDBAdapter } = await import("./cdb.js");
    const results = await withMockFetch(mockFetch, () => new CDBAdapter().fetchOpportunities());
    assert.equal(results.length, 1);
    assert.match(results[0].description, /stakeholder interviews/);
    assert.equal(results[0].deadline?.toISOString().slice(0, 10), "2026-10-23");
    assert.equal(results[0].rawData?.needsEnrichment, undefined);
  });
});

describe("CTO adapter", () => {
  it("throws when all requests fail (connection error)", async () => {
    const { CTOAdapter } = await import("./cto.js");
    const adapter = new CTOAdapter();
    await assert.rejects(
      () => withMockFetch(allFail, () => adapter.fetchOpportunities()),
      /CTO.*all.*request/i,
    );
  });

  it("returns empty array when page responds but has no matching links", async () => {
    const { CTOAdapter } = await import("./cto.js");
    const adapter = new CTOAdapter();
    const results = await withMockFetch(emptyHtmlPage, () => adapter.fetchOpportunities());
    assert.deepEqual(results, []);
  });
});

describe("EU Caribbean adapter", () => {
  it("throws when all requests fail (connection error)", async () => {
    const { EUCaribbeanAdapter } = await import("./eu-caribbean.js");
    const adapter = new EUCaribbeanAdapter();
    await assert.rejects(
      () => withMockFetch(allFail, () => adapter.fetchOpportunities()),
      /EU Caribbean.*all.*request/i,
    );
  });

  it("returns empty array when page responds but has no relevant links", async () => {
    const { EUCaribbeanAdapter } = await import("./eu-caribbean.js");
    const adapter = new EUCaribbeanAdapter();
    const results = await withMockFetch(emptyHtmlPage, () => adapter.fetchOpportunities());
    assert.deepEqual(results, []);
  });
});

// ── (2) Active adapters — also throw on total failure ─────────────────────────

describe("UNGM adapter", () => {
  it("throws when the server returns non-200", async () => {
    const { UNGMAdapter } = await import("./ungm.js");
    const adapter = new UNGMAdapter();
    await assert.rejects(
      () => withMockFetch(all403, () => adapter.fetchOpportunities()),
      /UNGM.*HTTP 403/i,
    );
  });

  it("returns empty array when page HTML has no notice links", async () => {
    const { UNGMAdapter } = await import("./ungm.js");
    const adapter = new UNGMAdapter();
    const results = await withMockFetch(emptyHtmlPage, () => adapter.fetchOpportunities());
    assert.deepEqual(results, []);
  });

  it("produces descriptions with enough context to pass eligibility content-quality gate", async () => {
    // Simulate a UNDP listing page with a table row containing notice link + surrounding columns
    const mockHtml: MockFetchFn = async () => new Response(
      `<html><body><table>
        <tr>
          <td><a href="view_notice.cfm?notice_id=99001">Caribbean Communications Specialist</a></td>
          <td>Barbados</td>
          <td>Individual Consultant — Communications and media services for UNDP Caribbean Country Office</td>
          <td>2026-09-30</td>
        </tr>
      </table></body></html>`,
      { status: 200, headers: { "content-type": "text/html" } },
    );

    const { UNGMAdapter } = await import("./ungm.js");
    const adapter = new UNGMAdapter();
    const results = await withMockFetch(mockHtml, () => adapter.fetchOpportunities());

    assert.equal(results.length, 1, "Should find 1 notice");
    const desc = results[0].description;
    // After stripping the title, remaining description must be >60 chars (eligibility gate)
    const safeTitle = results[0].title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const withoutTitle = desc.replace(new RegExp(safeTitle, "gi"), "").trim();
    assert.ok(
      withoutTitle.length > 60,
      `Description after removing title must be >60 chars to pass eligibility gate; got ${withoutTitle.length} chars: "${withoutTitle.slice(0, 100)}"`,
    );
  });

  it("retains a listing and marks it when detail enrichment fails", async () => {
    const mockHtml: MockFetchFn = async (url) => {
      if (url.includes("view_notice.cfm")) return new Response("Unavailable", { status: 503 });
      return new Response(`<table><tr><td>
        <a href="view_notice.cfm?notice_id=99002">Caribbean Research Consultant</a>
        <span>Barbados procurement services and stakeholder research scope</span>
      </td></tr></table>`, { status: 200, headers: { "content-type": "text/html" } });
    };
    const { UNGMAdapter } = await import("./ungm.js");
    const results = await withMockFetch(mockHtml, () => new UNGMAdapter().fetchOpportunities());
    assert.equal(results.length, 1);
    assert.equal(results[0].rawData?.needsEnrichment, true);
    assert.match(results[0].description, /Barbados procurement services/);
  });
});

describe("Bahamas Gov adapter", () => {
  it("throws when all requests return 403", async () => {
    const { BahamasGovAdapter } = await import("./bahamas-gov.js");
    const adapter = new BahamasGovAdapter();
    await assert.rejects(
      () => withMockFetch(all403, () => adapter.fetchOpportunities()),
      /Bahamas Gov.*all.*request/i,
    );
  });

  it("returns empty array when page responds but has no tender links", async () => {
    const { BahamasGovAdapter } = await import("./bahamas-gov.js");
    const adapter = new BahamasGovAdapter();
    const results = await withMockFetch(emptyHtmlPage, () => adapter.fetchOpportunities());
    assert.deepEqual(results, []);
  });
});

describe("CARICOM adapter", () => {
  it("throws when all requests return 404", async () => {
    const { CARICOMAdapter } = await import("./caricom.js");
    const adapter = new CARICOMAdapter();
    await assert.rejects(
      () => withMockFetch(all404, () => adapter.fetchOpportunities()),
      /CARICOM.*all.*request/i,
    );
  });

  it("returns empty array when page responds but has no procurement links", async () => {
    const { CARICOMAdapter } = await import("./caricom.js");
    const adapter = new CARICOMAdapter();
    const results = await withMockFetch(emptyHtmlPage, () => adapter.fetchOpportunities());
    assert.deepEqual(results, []);
  });

  it("produces descriptions with enough context to pass eligibility content-quality gate", async () => {
    // Simulate a CARICOM page with a procurement link inside a rich context block
    const mockHtml: MockFetchFn = async () => new Response(
      `<html><body>
        <article>
          <p>CARICOM Secretariat invites proposals from qualified firms to provide
          communications and public awareness campaign services for the CARICOM
          Single Market initiative. Ref: CS-2026-042. Deadline: 30 September 2026.
          <a href="/procurement/communications-campaign-cs2026042">
            Communications Campaign — CARICOM Single Market
          </a>
          Scope includes strategic communications, content creation, social media
          management, and community engagement across member states.</p>
        </article>
      </body></html>`,
      { status: 200, headers: { "content-type": "text/html" } },
    );

    const { CARICOMAdapter } = await import("./caricom.js");
    const adapter = new CARICOMAdapter();
    const results = await withMockFetch(mockHtml, () => adapter.fetchOpportunities());

    assert.ok(results.length > 0, "Should find at least 1 procurement link");
    const desc = results[0].description;
    const safeTitle = results[0].title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const withoutTitle = desc.replace(new RegExp(safeTitle, "gi"), "").trim();
    assert.ok(
      withoutTitle.length > 60,
      `Description after removing title must be >60 chars to pass eligibility gate; got ${withoutTitle.length} chars: "${withoutTitle.slice(0, 100)}"`,
    );
  });

  it("retains a discovered tender when its detail page is unavailable", async () => {
    const padding = " ".repeat(600);
    const mockHtml: MockFetchFn = async (url) => {
      if (url.includes("/procurement/partial")) return new Response("Unavailable", { status: 503 });
      if (url === "https://caricom.org/procurement-notices") {
        return new Response(`<article><a href="/procurement/partial">Regional communications tender</a>
          CARICOM Secretariat seeks proposals for public awareness and communications services. ${padding}</article>`,
          { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response("No notices", { status: 200, headers: { "content-type": "text/html" } });
    };
    const { CARICOMAdapter } = await import("./caricom.js");
    const results = await withMockFetch(mockHtml, () => new CARICOMAdapter().fetchOpportunities());
    assert.equal(results.length, 1);
    assert.equal(results[0].rawData?.needsEnrichment, true);
    assert.match(results[0].description, /public awareness and communications/);
  });
});

// ── (3) seedDefaultSources — blocked adapters enforce active=false ─────────────

describe("seedDefaultSources — deactivation enforcement", () => {
  it("contains an inArray UPDATE that forces blocked adapters to active=false", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(
      new URL("./index.ts", import.meta.url).pathname.replace(/[^/]+$/, "index.ts"),
      "utf-8",
    );

    // Structural: the upgrade-path deactivation must be an UPDATE (not just an insert flag)
    // so it applies to EXISTING deployments that already have these sources in the DB.
    assert.ok(
      source.includes("inArray"),
      "index.ts: missing inArray import — needed for retroactive deactivation UPDATE",
    );
    assert.ok(
      source.includes("PERMANENTLY_BLOCKED_ADAPTERS") || source.includes("BLOCKED_ADAPTER"),
      "index.ts: missing blocked-adapters constant for the retroactive deactivation UPDATE",
    );
    // Verify active=false is being SET (not just inserted)
    assert.ok(
      source.includes("set({ active: false })") || source.includes("set({active:false})"),
      "index.ts: missing .set({ active: false }) in the retroactive deactivation UPDATE",
    );
  });

  it("blocked adapter types are seeded with active=false in defaults array", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(
      new URL("./index.ts", import.meta.url).pathname.replace(/[^/]+$/, "index.ts"),
      "utf-8",
    );

    const blocked = ["idb", "cdb", "cto", "eu_caribbean"];
    for (const adapter of blocked) {
      const match = source.match(
        new RegExp(`adapterType:\\s*["']${adapter}["'][^}]+active:\\s*(true|false)`),
      );
      assert.ok(match, `${adapter}: missing adapterType + active flag in seedDefaultSources`);
      assert.equal(match[1], "false", `${adapter}: must be seeded with active=false`);
    }
  });
});

// ── (4) World Bank — correct deadline field ───────────────────────────────────

describe("World Bank adapter — correct deadline field", () => {
  it("uses submission_deadline_date as the deadline field", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(
      new URL("./world-bank.ts", import.meta.url).pathname.replace(/[^/]+$/, "world-bank.ts"),
      "utf-8",
    );
    assert.ok(
      source.includes("n.submission_deadline_date"),
      "world-bank.ts must read n.submission_deadline_date from the API response",
    );
  });

  it("filters out notices where the deadline is in the past", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(
      new URL("./world-bank.ts", import.meta.url).pathname.replace(/[^/]+$/, "world-bank.ts"),
      "utf-8",
    );
    assert.ok(
      source.includes("deadline <= now"),
      "world-bank.ts must skip items where deadline <= now",
    );
  });

  it("returns TenderOpportunity[] items with future deadlines when API responds", async () => {
    const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const mockApiResponse = {
      totalHits: 1,
      procnotices: [
        {
          id: "WB-TEST-001",
          project_name: "Caribbean Communications Program",
          submission_deadline_date: futureDate,
          submission_date: "2024-01-01",
          project_ctry_name: "Bahamas",
          notice_type: "Procurement",
          bid_description: "Communications and marketing services for the Caribbean region.",
        },
      ],
    };

    const mockWorldBankFetch: MockFetchFn = async () =>
      new Response(JSON.stringify(mockApiResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const { WorldBankAdapter } = await import("./world-bank.js");
    const adapter = new WorldBankAdapter();
    const results = await withMockFetch(mockWorldBankFetch, () => adapter.fetchOpportunities());

    assert.ok(results.length > 0, "Expected at least one result from valid World Bank API response");
    assert.ok(
      results[0].deadline instanceof Date,
      "deadline should be a Date object",
    );
    assert.ok(
      results[0].deadline! > new Date(),
      "deadline should be in the future",
    );
  });
});
