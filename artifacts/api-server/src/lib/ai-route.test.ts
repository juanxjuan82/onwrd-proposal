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

    it("POST /api/tenders/import-csv (JSON-body CSV) makes zero AI calls", async () => {
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
  });

  // ── Zero-AI automatic paths — crawl trigger ────────────────────────────────

  describe("zero invokeAI calls on crawl trigger path", () => {
    it("POST /api/tender-intelligence/crawl with lock held returns 409, zero AI calls", async () => {
      // Hold the crawl lock so the route returns 409 without starting a crawl.
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
  });
});
