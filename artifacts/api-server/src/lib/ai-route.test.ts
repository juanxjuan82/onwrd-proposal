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
 * All hooks are scoped inside the top-level describe so that the before/after
 * run in the correct order when node:test runs multiple files in the same process.
 */

import http from "node:http";
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import app from "../app.js";
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
    // Count calls but do NOT throw — this lets the route complete and we can
    // inspect the count after, giving better diagnostics than a 500 error.
    __setInvokeAISpy(async (_p: InvokeAIParams): Promise<AIResult> => {
      count++;
      return { content: "unexpected-ai-call", model: "mock" };
    });
    return {
      getCount: () => count,
      restore:  () => __setInvokeAISpy(null),
    };
  }

  // ── Zero-AI automatic paths ─────────────────────────────────────────────────

  describe("zero invokeAI calls on automatic creation paths", () => {
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
});
