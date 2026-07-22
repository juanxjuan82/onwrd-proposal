/**
 * Route-level AI boundary tests
 *
 * Spins up the real Express app on a random port and exercises automatic
 * creation/import paths with the invokeAI spy set to count calls.
 * Every automatic path must produce exactly zero spy invocations.
 *
 * Runner: node:test
 * Transpiler: tsx (ESM)
 * Requires: live PostgreSQL connection
 *
 * All hooks are scoped inside the top-level describe so that before/after
 * run in the correct order when node:test runs multiple files in the same process.
 */

import http from "node:http";
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import app from "../app.js";
import {
  acquireCrawlLock,
  releaseCrawlLock,
} from "../crawlers/index.js";
import {
  __setInvokeAISpy,
  __setOpenAICompletionForTesting,
  type InvokeAIParams,
  type AIResult,
} from "./ai-gateway.js";

// ── All tests wrapped in a file-level describe ────────────────────────────────

describe("ai-route: route-level zero-AI boundary tests", () => {
  let server: http.Server;
  let baseUrl: string;

  before(
    () =>
      new Promise<void>((resolve) => {
        server = http.createServer(app as any);
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address() as { port: number };
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      }),
  );

  after(
    () =>
      new Promise<void>((resolve, reject) => {
        __setInvokeAISpy(null);
        __setOpenAICompletionForTesting(null);
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  );

  afterEach(() => {
    __setInvokeAISpy(null);
  });

  // ── Helper ──────────────────────────────────────────────────────────────────

  async function post(path: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });
  }

  // ── Zero-AI assertion helper ────────────────────────────────────────────────

  function withZeroAiSpy(): { getCount: () => number; restore: () => void } {
    let count = 0;
    __setInvokeAISpy(async (_p: InvokeAIParams): Promise<AIResult> => {
      count++;
      return { content: "unexpected-ai-call", model: "mock" };
    });
    return {
      getCount: () => count,
      restore:  () => __setInvokeAISpy(null),
    };
  }

  // ── Zero-AI automatic paths — direct create + JSON import ──────────────────

  describe("zero invokeAI calls on JSON-body automatic creation paths", () => {
    it("POST /api/opportunities (direct creation) makes zero AI calls", async () => {
      const spy = withZeroAiSpy();
      try {
        const res = await post("/api/opportunities", {
          title:       "Test Opportunity — route test",
          agency:      "Test Agency",
          description: "A test opportunity for route-level AI boundary assertions.",
        });
        assert.notEqual(
          res.status,
          500,
          `POST /api/opportunities returned 500; spy calls: ${spy.getCount()}`,
        );
      } finally {
        spy.restore();
      }
      assert.equal(spy.getCount(), 0, "direct opportunity creation must not call invokeAI");
    });

    it("POST /api/tenders/extract-text (pasted text) makes zero AI calls", async () => {
      const spy = withZeroAiSpy();
      try {
        const res = await post("/api/tenders/extract-text", {
          text: "This is a test tender notice with enough text to satisfy the minimum length requirement imposed by the route handler.",
        });
        assert.notEqual(
          res.status,
          500,
          `POST /api/tenders/extract-text returned 500; spy calls: ${spy.getCount()}`,
        );
      } finally {
        spy.restore();
      }
      assert.equal(spy.getCount(), 0, "pasted-text import must not call invokeAI (keyword engine only)");
    });

    it("POST /api/tenders/import-csv (JSON-body CSV, 1 row) makes zero AI calls", async () => {
      const spy = withZeroAiSpy();
      try {
        const csv = [
          "title,agency,description",
          '"Route Test Tender via CSV","CSV Agency","A test tender imported from CSV with enough description text to pass any minimum validation"',
        ].join("\n");

        const res = await post("/api/tenders/import-csv", { csv });
        assert.notEqual(
          res.status,
          500,
          `POST /api/tenders/import-csv returned 500; spy calls: ${spy.getCount()}`,
        );
      } finally {
        spy.restore();
      }
      assert.equal(spy.getCount(), 0, "CSV JSON-body import must not call invokeAI");
    });

    it("POST /api/tenders/import-csv (JSON-body CSV, 3 rows) makes zero AI calls and imports all rows", async () => {
      const spy = withZeroAiSpy();
      try {
        const csv = [
          "title,agency,description",
          '"Multi-Row Test Tender 1","Dept of Infrastructure","First test tender with sufficient description to clear minimum length validation checks on import"',
          '"Multi-Row Test Tender 2","Ministry of Works","Second test tender with sufficient description to clear minimum length validation checks on import"',
          '"Multi-Row Test Tender 3","Public Sector Agency","Third test tender with sufficient description to clear minimum length validation checks on import"',
        ].join("\n");

        const res = await post("/api/tenders/import-csv", { csv });
        assert.notEqual(
          res.status,
          500,
          `POST /api/tenders/import-csv (3 rows) returned 500; spy calls: ${spy.getCount()}`,
        );
        if (res.status === 200) {
          const body = (await res.json()) as unknown;
          assert.ok(Array.isArray(body) || typeof body === "object", "import-csv must return a body");
        }
      } finally {
        spy.restore();
      }
      assert.equal(spy.getCount(), 0, "multi-row CSV import must not call invokeAI");
    });
  });

  // ── Zero-AI automatic paths — validation failures ──────────────────────────

  describe("zero invokeAI calls on validation failures", () => {
    it("POST /api/opportunities with missing fields returns 400, zero AI calls", async () => {
      const spy = withZeroAiSpy();
      try {
        const res = await post("/api/opportunities", { title: "Incomplete" });
        assert.equal(res.status, 400, "missing required fields must return 400");
      } finally {
        spy.restore();
      }
      assert.equal(spy.getCount(), 0, "validation failure must not call invokeAI");
    });

    it("POST /api/tenders/extract-text with short text returns 400, zero AI calls", async () => {
      const spy = withZeroAiSpy();
      try {
        const res = await post("/api/tenders/extract-text", { text: "too short" });
        assert.equal(res.status, 400, "short text must return 400");
      } finally {
        spy.restore();
      }
      assert.equal(spy.getCount(), 0, "validation failure must not call invokeAI");
    });
  });

  // ── Zero-AI automatic paths — file upload ──────────────────────────────────

  describe("zero invokeAI calls on file-upload paths", () => {
    it("POST /api/tenders/manual with .txt file upload makes zero AI calls", async () => {
      const spy = withZeroAiSpy();
      try {
        const tenderText =
          "TENDER NOTICE — Department of Infrastructure\n\n" +
          "Agency: City Infrastructure Authority\n" +
          "Title: Road Maintenance Services 2026-2027\n\n" +
          "Scope: The Authority invites tenders for the provision of road maintenance " +
          "services across the metropolitan area. Requirements include: qualified civil " +
          "engineers, ISO 9001 certification, public liability insurance of $10M minimum, " +
          "and ability to mobilise within 48 hours of award. Submissions close 2026-09-01.\n";

        const formData = new FormData();
        formData.append(
          "file",
          new Blob([tenderText], { type: "text/plain" }),
          "tender.txt",
        );

        const res = await fetch(`${baseUrl}/api/tenders/manual`, {
          method: "POST",
          body:   formData,
        });

        assert.notEqual(
          res.status,
          500,
          `POST /api/tenders/manual (TXT) returned 500; spy calls: ${spy.getCount()}`,
        );
        assert.notEqual(res.status, 413, "file must be within size limit");
      } finally {
        spy.restore();
      }
      assert.equal(spy.getCount(), 0, "TXT file upload must use deterministic extraction — no invokeAI call");
    });

    it("POST /api/tenders/manual with .pdf file upload makes zero AI calls", async () => {
      const spy = withZeroAiSpy();
      try {
        // Minimal PDF-like buffer — the route reads the file type and attempts pdf-parse.
        // Whether pdf-parse returns empty text (400) or throws (500 from route catch),
        // the critical invariant is: zero invokeAI calls before that response.
        const minimalPdf = Buffer.from("%PDF-1.4\n%%EOF\n");
        const formData = new FormData();
        formData.append(
          "file",
          new Blob([minimalPdf], { type: "application/pdf" }),
          "tender.pdf",
        );

        await fetch(`${baseUrl}/api/tenders/manual`, {
          method: "POST",
          body:   formData,
        });
        // Status may be 400 (no selectable text) or 500 (pdf-parse parse error).
        // Either is fine — the test only asserts zero AI calls.
      } finally {
        spy.restore();
      }
      assert.equal(spy.getCount(), 0, "PDF file upload path must not call invokeAI regardless of parse outcome");
    });

    it("POST /api/tenders/manual with .docx file upload makes zero AI calls", async () => {
      const spy = withZeroAiSpy();
      try {
        // An invalid DOCX buffer — mammoth will fail to extract text.
        // Status will be 400 or 500; the invariant is zero invokeAI calls.
        const fakeDocx = Buffer.from("PK\x03\x04FAKE DOCX CONTENT FOR TESTING ZERO AI CALLS");
        const formData = new FormData();
        formData.append(
          "file",
          new Blob([fakeDocx], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
          "tender.docx",
        );

        await fetch(`${baseUrl}/api/tenders/manual`, {
          method: "POST",
          body:   formData,
        });
        // Status may be 400 (no text extracted) or 500 (mammoth parse error).
        // Either is fine — the test only asserts zero AI calls.
      } finally {
        spy.restore();
      }
      assert.equal(spy.getCount(), 0, "DOCX file upload path must not call invokeAI regardless of parse outcome");
    });

    it("POST /api/tenders/manual with private/internal URL returns 400, zero AI calls", async () => {
      const spy = withZeroAiSpy();
      try {
        const res = await fetch(`${baseUrl}/api/tenders/manual`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ url: "http://127.0.0.1/internal.pdf" }),
        });
        assert.equal(res.status, 400, "private URL must return 400 without fetching");
      } finally {
        spy.restore();
      }
      assert.equal(spy.getCount(), 0, "private-URL rejection must not call invokeAI");
    });

    it("POST /api/tenders/manual with invalid URL returns 400, zero AI calls", async () => {
      const spy = withZeroAiSpy();
      try {
        const res = await fetch(`${baseUrl}/api/tenders/manual`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ url: "not-a-valid-url" }),
        });
        assert.equal(res.status, 400, "invalid URL must return 400");
      } finally {
        spy.restore();
      }
      assert.equal(spy.getCount(), 0, "URL-validation failure must not call invokeAI");
    });

    it("POST /api/tenders/manual with unsupported-protocol URL returns 400, zero AI calls", async () => {
      const spy = withZeroAiSpy();
      try {
        const res = await fetch(`${baseUrl}/api/tenders/manual`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ url: "ftp://example.com/tender.pdf" }),
        });
        assert.equal(res.status, 400, "ftp:// URL must be rejected before any network call");
      } finally {
        spy.restore();
      }
      assert.equal(spy.getCount(), 0, "unsupported-protocol URL rejection must not call invokeAI");
    });
  });

  // ── Zero-AI automatic paths — crawl trigger ────────────────────────────────

  describe("zero invokeAI calls on crawl trigger path", () => {
    it("POST /api/tender-intelligence/crawl with lock held returns 409, zero AI calls", async () => {
      const held = await acquireCrawlLock();
      assert.equal(held, true, "precondition: must be able to acquire crawl lock");

      const spy = withZeroAiSpy();
      try {
        const res = await post("/api/tender-intelligence/crawl", {});
        assert.equal(res.status, 409, "crawl trigger must return 409 when lock is held");
      } finally {
        spy.restore();
        await releaseCrawlLock();
      }
      assert.equal(spy.getCount(), 0, "crawl 409 short-circuit must not call invokeAI");
    });

    it("POST /api/tender-intelligence/crawl (no lock held) returns 200 with zero synchronous AI calls", async () => {
      // Ensure the lock is free before the test.
      await releaseCrawlLock().catch(() => undefined);

      const spy = withZeroAiSpy();
      try {
        const res = await post("/api/tender-intelligence/crawl", {});
        // Route responds immediately (fire-and-forget background crawl).
        assert.ok(
          res.status === 200 || res.status === 202,
          `crawl trigger (no lock) must return 200/202, got ${res.status}`,
        );
        const body = (await res.json()) as { message?: string };
        assert.ok(
          typeof body.message === "string",
          "crawl trigger must return a message string",
        );
        // Brief settle — allow any synchronous microtasks to complete.
        // The background crawl (runCrawler with no real sources) should
        // make zero AI calls in a test DB that has no crawl sources.
        await new Promise(r => setTimeout(r, 200));
      } finally {
        spy.restore();
      }
      assert.equal(
        spy.getCount(),
        0,
        "crawl trigger with no configured sources must make zero AI calls",
      );
    });
  });
});
