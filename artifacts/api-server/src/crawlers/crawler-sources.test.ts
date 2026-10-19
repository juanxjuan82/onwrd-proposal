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
    const guard = source.indexOf("if (canRefreshIncompleteDiscovery(");
    assert.notEqual(guard, -1, "canonical opportunities must not be overwritten by crawler refreshes");
    const update = source.slice(guard, source.indexOf("const eligibility", guard));
    assert.match(update, /profileMatchesOpportunity/);
    assert.match(update, /fitScore: refreshedScore\.fitScore/);
    assert.doesNotMatch(update, /\btitle:\s*opp\.title/);
    assert.doesNotMatch(update, /\borganization:\s*opp\.organization/);
  });

  it("stores new attachment evidence on linked discoveries without rewriting canonical fields", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const guard = source.indexOf("if (existing.opportunityId !== null)");
    assert.notEqual(guard, -1);
    const update = source.slice(guard, source.indexOf("if (canRefreshIncompleteDiscovery(", guard));
    assert.match(update, /mergeDocumentEvidence/);
    assert.match(update, /rawData:\s*evidenceOnlyRaw/);
    assert.doesNotMatch(update, /description:|deadline:|recommendation:|status:|opportunityId:/);
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

  it("reserves database-bound detail space for extracted TOR text", async () => {
    const { prioritizeDocumentContent, mergeDocumentEvidence } = await import("./base-adapter.js");
    const extractedText = "TOR SCOPE: stakeholder interviews, final reporting, deliverable milestones.";
    const content = prioritizeDocumentContent(
      "Page content ".repeat(500),
      [{
        url: "https://example.org/files/terms-of-reference.pdf",
        format: "pdf",
        status: "extracted",
        characters: extractedText.length,
        extractedText,
      }],
    );
    assert.ok(content.length <= 4_000);
    assert.match(content, /TOR SCOPE: stakeholder interviews/);

    const merged = mergeDocumentEvidence(
      {
        humanReviewMarker: "keep",
        documentExtraction: [{
          url: "https://example.org/files/terms-of-reference.pdf",
          status: "fetch_failed",
        }],
      },
      {
        documentExtraction: [{
          url: "https://example.org/files/terms-of-reference.pdf",
          status: "extracted",
          extractedText,
          characters: extractedText.length,
          format: "pdf",
        }],
      },
    );
    assert.equal(merged?.humanReviewMarker, "keep");
    assert.equal(
      (merged?.documentExtraction as Array<{ extractedText?: string }>)[0].extractedText,
      extractedText,
    );
    assert.equal(mergeDocumentEvidence(merged!, { documentExtraction: [{
      url: "https://example.org/files/terms-of-reference.pdf",
      status: "extracted",
      extractedText,
    }] }), undefined, "same extracted text is idempotent");
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
    const adapter = new CDBAdapter(0);
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
    const adapter = new CDBAdapter(0);
    const results = await withMockFetch(async (url) => url.endsWith("/robots.txt")
      ? new Response("User-agent: *\nAllow: /", {
        status: 200,
        headers: { "content-type": "text/plain" },
      })
      : emptyHtmlPage(url), () => adapter.fetchOpportunities());
    assert.deepEqual(results, []);
  });

  it("extracts a CDB notice detail and deadline from the procurement listing", async () => {
    const mockFetch: MockFetchFn = async (url) => {
      if (url.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nAllow: /", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
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
    const results = await withMockFetch(mockFetch, () => new CDBAdapter(0).fetchOpportunities());
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
  it("refuses all requests while UNDP robots.txt disallows all paths", async () => {
    const { UNGMAdapter } = await import("./ungm.js");
    let requests = 0;
    await assert.rejects(
      () => withMockFetch(async () => {
        requests++;
        return new Response("unexpected request");
      }, () => new UNGMAdapter().fetchOpportunities()),
      /robots\.txt disallows all paths/i,
    );
    assert.equal(requests, 0);
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
  it("does not request the listing when robots.txt blocks it", async () => {
    const requests: string[] = [];
    const { CARICOMAdapter } = await import("./caricom.js");
    await assert.rejects(
      () => withMockFetch(async (url) => {
        const path = new URL(url).pathname;
        requests.push(path);
        return new Response("User-agent: *\nDisallow: /", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }, () => new CARICOMAdapter(0).fetchOpportunities()),
      /robots\.txt disallows the procurement-notices listing path/i,
    );
    assert.deepEqual(requests, ["/robots.txt"]);
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

  it("blocked and pilot-gated adapter types are seeded with active=false", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(
      new URL("./index.ts", import.meta.url).pathname.replace(/[^/]+$/, "index.ts"),
      "utf-8",
    );

    const inactive = ["idb", "cdb", "caricom", "cto", "eu_caribbean"];
    for (const adapter of inactive) {
      const match = source.match(
        new RegExp(`adapterType:\\s*["']${adapter}["'][^}]+active:\\s*(true|false)`),
      );
      assert.ok(match, `${adapter}: missing adapterType + active flag in seedDefaultSources`);
      assert.equal(match[1], "false", `${adapter}: must be seeded with active=false`);
    }
  });

  it("requires a current-version successful pilot before keeping CDB or CARICOM active", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(
      new URL("./index.ts", import.meta.url).pathname.replace(/[^/]+$/, "index.ts"),
      "utf-8",
    );
    const guardStart = source.indexOf("const activePilotSources");
    const guardEnd = source.indexOf("const existing = await db.select().from(tenderSourcesTable)", guardStart);
    assert.ok(guardStart >= 0 && guardEnd > guardStart, "missing controlled-pilot startup guard");
    const guard = source.slice(guardStart, guardEnd);
    assert.match(guard, /inArray\(tenderSourcesTable\.adapterType,\s*\["cdb",\s*"caricom"\]\)/);
    assert.match(guard, /sourceConfigurationVersion/);
    assert.match(guard, /eq\(crawlerRunsTable\.status,\s*"success"\)/);
    assert.match(guard, /gte\(crawlerRunsTable\.itemsNew,\s*1\)/);
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
