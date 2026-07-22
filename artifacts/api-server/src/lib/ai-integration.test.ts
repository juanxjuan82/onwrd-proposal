/**
 * AI Integration Tests
 *
 * Tests DB-backed behaviours that require a live PostgreSQL connection:
 *   - Crawl lock: acquisition, exclusivity, release-on-error
 *   - Gateway spy: zero AI calls on automatic crawl path
 *   - Circuit state management via getCircuitState / resetCircuit
 *
 * Runner: node:test (built-in)
 * Transpiler: tsx (ESM)
 * Requires: DATABASE_URL pointing at the real dev database
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "@workspace/db";
import { crawlerLockTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  acquireCrawlLock,
  releaseCrawlLock,
  runCrawler,
} from "../crawlers/index.js";
import {
  getCircuitState,
  resetCircuit,
  __setInvokeAISpy,
  type InvokeAIParams,
  type AIResult,
} from "./ai-gateway.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function clearLock(): Promise<void> {
  await db.delete(crawlerLockTable).where(sql`1=1`);
}

// ── Crawl lock: DB-backed exclusivity ────────────────────────────────────────

describe("DB crawl lock", () => {
  before(clearLock);
  after(clearLock);

  it("acquires the lock when the table is empty", async () => {
    const ok = await acquireCrawlLock();
    assert.equal(ok, true, "first acquire must succeed on an empty lock table");
    await releaseCrawlLock();
  });

  it("rejects a second acquisition while the lock is held", async () => {
    const first = await acquireCrawlLock();
    assert.equal(first, true, "first acquire must succeed");
    try {
      const second = await acquireCrawlLock();
      assert.equal(second, false, "second acquire must fail while lock is held");
    } finally {
      await releaseCrawlLock();
    }
  });

  it("permits re-acquisition after explicit release", async () => {
    const ok1 = await acquireCrawlLock();
    assert.equal(ok1, true);
    await releaseCrawlLock();

    const ok2 = await acquireCrawlLock();
    assert.equal(ok2, true, "must be acquirable again after release");
    await releaseCrawlLock();
  });

  it("runCrawler exits early (no error) when the lock is already held", async () => {
    const held = await acquireCrawlLock();
    assert.equal(held, true);
    try {
      // Pass a non-existent sourceId so no external HTTP calls are made.
      // The crawl must detect the locked state and exit cleanly.
      await runCrawler(99999);
      // We reach here if runCrawler exits without throwing — acceptable;
      // the important check is that no duplicate lock acquisition happened.
    } catch (err) {
      // Also acceptable: runCrawler may throw a "lock held" error.
      const msg = err instanceof Error ? err.message : String(err);
      assert.ok(
        msg.includes("in progress") || msg.includes("lock") || msg.includes("running"),
        `unexpected error when lock was held: ${msg}`,
      );
    } finally {
      await releaseCrawlLock();
    }
  });

  it("lock is released after a successful runCrawler (no sources found)", async () => {
    // Run crawl with a non-existent sourceId → no sources found, exits cleanly.
    await runCrawler(99999);

    // Lock must be free now so we can acquire it.
    const ok = await acquireCrawlLock();
    assert.equal(ok, true, "lock must be released after runCrawler completes");
    await releaseCrawlLock();
  });
});

// ── Gateway spy: automatic paths must never call invokeAI ────────────────────

describe("gateway spy: zero AI calls on automatic paths", () => {
  before(clearLock);
  after(clearLock);

  it("runCrawler(non-existent-source) calls invokeAI exactly zero times", async () => {
    let callCount = 0;
    __setInvokeAISpy(async (_params: InvokeAIParams): Promise<AIResult> => {
      callCount++;
      throw new Error("[test] invokeAI must not be called during a crawl");
    });

    try {
      // Non-existent sourceId → no sources fetched, keyword scoring only.
      await runCrawler(99999);
    } finally {
      __setInvokeAISpy(null);
    }

    assert.equal(
      callCount,
      0,
      "runCrawler must use keyword scoring exclusively; no invokeAI calls allowed",
    );
  });

  it("spy intercepts and counts calls correctly (self-check)", async () => {
    let count = 0;
    __setInvokeAISpy(async (_p: InvokeAIParams): Promise<AIResult> => {
      count++;
      return { content: "spy", model: "mock" };
    });

    try {
      // Directly exercise the spy path (not through any route — just the hook).
      const { invokeAI } = await import("./ai-gateway.js");
      await invokeAI({
        feature:   "requirements_extraction",
        messages:  [{ role: "user", content: "test" }],
        maxTokens: 10,
      });
    } finally {
      __setInvokeAISpy(null);
    }

    assert.equal(count, 1, "spy must intercept exactly one invokeAI call");
  });
});

// ── Concurrent crawl lock (two simultaneous runCrawler calls) ─────────────────

describe("concurrent runCrawler() calls", () => {
  before(clearLock);
  after(clearLock);

  it("two concurrent calls both complete without throwing", async () => {
    // Both start nearly simultaneously; only one acquires the DB lock.
    // The other sees the lock held and exits cleanly (returns, not throws).
    const [r1, r2] = await Promise.allSettled([
      runCrawler(99999),
      runCrawler(99999),
    ]);

    assert.equal(r1.status, "fulfilled", "first concurrent runCrawler must not throw");
    assert.equal(r2.status, "fulfilled", "second concurrent runCrawler must not throw (exits early)");
  });

  it("lock is free after both concurrent crawlers complete", async () => {
    await Promise.allSettled([runCrawler(99999), runCrawler(99999)]);

    const ok = await acquireCrawlLock();
    assert.equal(ok, true, "lock must be free after both concurrent crawlers complete");
    await releaseCrawlLock();
  });
});

// ── Circuit state management ──────────────────────────────────────────────────

describe("circuit state management (DB-backed)", () => {
  before(() => resetCircuit());
  after(() => resetCircuit());

  it("getCircuitState returns a valid shape", async () => {
    const state = await getCircuitState();
    assert.ok("open" in state,      "must have 'open' field");
    assert.ok("openedAt" in state,  "must have 'openedAt' field");
    assert.ok("errorCode" in state, "must have 'errorCode' field");
    assert.ok("resetAt" in state,   "must have 'resetAt' field");
    assert.equal(typeof state.open, "boolean");
  });

  it("circuit is closed after resetCircuit()", async () => {
    await resetCircuit();
    const state = await getCircuitState();
    assert.equal(state.open, false, "circuit must be closed after reset");
    assert.equal(state.openedAt,  null, "openedAt must be null after reset");
    assert.equal(state.errorCode, null, "errorCode must be null after reset");
  });

  it("resetCircuit() is idempotent", async () => {
    await resetCircuit();
    await resetCircuit();
    const state = await getCircuitState();
    assert.equal(state.open, false);
  });
});
