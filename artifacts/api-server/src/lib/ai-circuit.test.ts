/**
 * AI Circuit & Retry Integration Tests
 *
 * Uses __setOpenAICompletionForTesting to inject mock provider behaviour while
 * keeping the full gateway logic live (circuit, quota, DB writes, error classification).
 *
 * Runner: node:test
 * Transpiler: tsx (ESM)
 * Requires: live PostgreSQL connection
 *
 * All hooks are scoped inside the top-level describe so that before/after/
 * afterEach run in the correct order when node:test runs multiple files in the
 * same process.
 */

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "@workspace/db";
import { aiDailyQuotaTable, aiUsageLogTable } from "@workspace/db";
import { eq, and, gte, desc } from "drizzle-orm";
import {
  invokeAI,
  getCircuitState,
  resetCircuit,
  GatewayCircuitOpenError,
  GatewayLimitError,
  __setInvokeAISpy,
  __setOpenAICompletionForTesting,
  type InvokeAIParams,
} from "./ai-gateway.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE_PARAMS: InvokeAIParams = {
  feature:   "requirements_extraction",
  messages:  [{ role: "user", content: "circuit integration test" }],
  maxTokens: 10,
};

function makeSuccessCompletion(content = "ok") {
  return {
    choices: [{ message: { content } }],
    model:   "gpt-4o-mini",
    usage:   { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
  };
}

// ── All tests wrapped in a file-level describe so that before/after/afterEach
//    are scoped here and don't bleed into other files when node:test runs
//    multiple files in the same process.
// ─────────────────────────────────────────────────────────────────────────────

describe("ai-circuit: gateway circuit/retry integration", () => {
  let savedCallLimit: string | undefined;
  let savedTokenLimit: string | undefined;
  let savedReqLimit:   string | undefined;

  // Set very high daily limits so accumulated DB quota never blocks these tests.
  // Individual tests temporarily override specific limits for their own assertions.
  before(async () => {
    savedCallLimit  = process.env.AI_DAILY_CALL_LIMIT;
    savedTokenLimit = process.env.AI_DAILY_TOKEN_LIMIT;
    savedReqLimit   = process.env.AI_DAILY_REQUIREMENTS_LIMIT;

    process.env.AI_DAILY_CALL_LIMIT         = "99999";
    process.env.AI_DAILY_TOKEN_LIMIT        = "999999999";
    process.env.AI_DAILY_REQUIREMENTS_LIMIT = "99999";

    __setInvokeAISpy(null);
    __setOpenAICompletionForTesting(null);
    await resetCircuit();
  });

  after(async () => {
    __setOpenAICompletionForTesting(null);
    __setInvokeAISpy(null);

    const env = process.env as Record<string, string | undefined>;
    if (savedCallLimit  !== undefined) env.AI_DAILY_CALL_LIMIT         = savedCallLimit;
    else delete env.AI_DAILY_CALL_LIMIT;
    if (savedTokenLimit !== undefined) env.AI_DAILY_TOKEN_LIMIT        = savedTokenLimit;
    else delete env.AI_DAILY_TOKEN_LIMIT;
    if (savedReqLimit   !== undefined) env.AI_DAILY_REQUIREMENTS_LIMIT = savedReqLimit;
    else delete env.AI_DAILY_REQUIREMENTS_LIMIT;

    await resetCircuit();
  });

  afterEach(async () => {
    __setOpenAICompletionForTesting(null);
    await resetCircuit();
  });

  // ── Circuit breaker ─────────────────────────────────────────────────────────

  describe("circuit breaker", () => {
    it("insufficient_quota error opens the circuit", async () => {
      __setOpenAICompletionForTesting(async () => {
        const err: any = new Error("You exceeded your current quota");
        err.status = 402;
        err.code   = "insufficient_quota";
        throw err;
      });

      let caughtErr: unknown;
      try {
        await invokeAI(BASE_PARAMS);
      } catch (err) {
        caughtErr = err;
      }

      assert.ok(caughtErr, "invokeAI must throw on insufficient_quota");

      const state = await getCircuitState();
      assert.equal(state.open,      true,                 "circuit must be open after quota error");
      assert.equal(state.errorCode, "insufficient_quota", "errorCode must be set");
      assert.ok(state.openedAt instanceof Date,           "openedAt must be a Date");
    });

    it("subsequent calls return GatewayCircuitOpenError without hitting provider", async () => {
      // Step 1 — open the circuit via a quota error.
      __setOpenAICompletionForTesting(async () => {
        const err: any = new Error("exceeded quota");
        err.status = 402;
        throw err;
      });
      try { await invokeAI(BASE_PARAMS); } catch { /* expected */ }

      // Step 2 — replace mock and verify no provider call happens.
      let providerHits = 0;
      __setOpenAICompletionForTesting(async () => {
        providerHits++;
        return makeSuccessCompletion();
      });

      let circuitErr: unknown;
      try {
        await invokeAI({ ...BASE_PARAMS, messages: [{ role: "user", content: "after open" }] });
      } catch (err) {
        circuitErr = err;
      }

      assert.ok(
        circuitErr instanceof GatewayCircuitOpenError,
        "must throw GatewayCircuitOpenError when circuit is open",
      );
      assert.equal(providerHits, 0, "provider must not be called when circuit is open");
    });

    it("resetCircuit closes the circuit and allows calls again", async () => {
      // Open the circuit.
      __setOpenAICompletionForTesting(async () => {
        const err: any = new Error("exceeded quota");
        err.status = 402;
        throw err;
      });
      try { await invokeAI(BASE_PARAMS); } catch { /* expected */ }

      // Reset, then verify a success call gets through.
      await resetCircuit();
      const stateAfterReset = await getCircuitState();
      assert.equal(stateAfterReset.open, false, "circuit must be closed after reset");

      let callSucceeded = false;
      __setOpenAICompletionForTesting(async () => {
        callSucceeded = true;
        return makeSuccessCompletion("post-reset response");
      });
      const result = await invokeAI(BASE_PARAMS);
      assert.equal(callSucceeded,  true,                   "provider must be called after circuit reset");
      assert.equal(result.content, "post-reset response",  "must return provider content");
    });
  });

  // ── Rate-limit retry ────────────────────────────────────────────────────────

  describe("rate-limit retry", () => {
    it("rate-limit error with permitRetry calls provider at most twice", async () => {
      let providerCalls = 0;
      __setOpenAICompletionForTesting(async () => {
        providerCalls++;
        if (providerCalls === 1) {
          const err: any = new Error("rate limit exceeded");
          err.status  = 429;
          err.headers = { "retry-after": "0.001" };
          throw err;
        }
        return makeSuccessCompletion("retry success");
      });

      const result = await invokeAI({ ...BASE_PARAMS, permitRetry: true });

      assert.equal(providerCalls,  2,               "provider must be called twice (initial + retry)");
      assert.equal(result.content, "retry success", "must return the retry content");
    });

    it("rate-limit error without permitRetry does NOT retry", async () => {
      let providerCalls = 0;
      __setOpenAICompletionForTesting(async () => {
        providerCalls++;
        const err: any = new Error("rate limit exceeded");
        err.status = 429;
        throw err;
      });

      try { await invokeAI(BASE_PARAMS); } catch { /* expected */ }

      assert.equal(providerCalls, 1, "provider must be called exactly once (no retry without flag)");
    });
  });

  // ── Feature-scope daily call-limit concurrency ─────────────────────────────

  describe("feature-scope daily call-limit enforcement", () => {
    it("concurrent calls against the feature limit: exactly one succeeds, one gets GatewayLimitError", async () => {
      const today = new Date().toISOString().split("T")[0]!;

      const [quota] = await db
        .select({ calls: aiDailyQuotaTable.calls })
        .from(aiDailyQuotaTable)
        .where(and(
          eq(aiDailyQuotaTable.date, today),
          eq(aiDailyQuotaTable.scope, "feature:requirements_extraction"),
        ));
      const baseCalls = quota?.calls ?? 0;

      // Allow exactly one more feature call.
      process.env.AI_DAILY_REQUIREMENTS_LIMIT = String(baseCalls + 1);

      __setOpenAICompletionForTesting(async () => makeSuccessCompletion("concurrent ok"));

      const params: InvokeAIParams = {
        feature:   "requirements_extraction",
        messages:  [{ role: "user", content: "concurrent feature limit test" }],
        maxTokens: 10,
      };

      const [r1, r2] = await Promise.allSettled([invokeAI(params), invokeAI(params)]);

      // Restore the high limit set in the before() hook.
      process.env.AI_DAILY_REQUIREMENTS_LIMIT = "99999";

      const successes   = [r1, r2].filter(r => r.status === "fulfilled");
      const limitErrors = [r1, r2].filter(
        r => r.status === "rejected" && r.reason instanceof GatewayLimitError,
      );

      assert.equal(successes.length,   1, "exactly one concurrent call must succeed");
      assert.equal(limitErrors.length, 1, "exactly one concurrent call must get GatewayLimitError");
    });
  });

  // ── Global daily call-limit concurrency ────────────────────────────────────

  describe("global daily call-limit enforcement", () => {
    it("concurrent calls against the global limit: exactly one succeeds, one gets GatewayLimitError", async () => {
      const today = new Date().toISOString().split("T")[0]!;

      // Read current global quota so we can set the limit to exactly one above it.
      const [quota] = await db
        .select({ calls: aiDailyQuotaTable.calls })
        .from(aiDailyQuotaTable)
        .where(and(
          eq(aiDailyQuotaTable.date, today),
          eq(aiDailyQuotaTable.scope, "global"),
        ));
      const baseGlobal = quota?.calls ?? 0;

      // Allow exactly one more global call; feature limit stays at 99999.
      process.env.AI_DAILY_CALL_LIMIT = String(baseGlobal + 1);

      __setOpenAICompletionForTesting(async () => makeSuccessCompletion("global-ok"));

      const params: InvokeAIParams = {
        feature:   "requirements_extraction",
        messages:  [{ role: "user", content: "concurrent global limit test" }],
        maxTokens: 10,
      };

      const [r1, r2] = await Promise.allSettled([invokeAI(params), invokeAI(params)]);

      // Restore the high global limit set in the before() hook.
      process.env.AI_DAILY_CALL_LIMIT = "99999";

      const successes   = [r1, r2].filter(r => r.status === "fulfilled");
      const limitErrors = [r1, r2].filter(
        r => r.status === "rejected" && r.reason instanceof GatewayLimitError,
      );

      assert.equal(successes.length,   1, "exactly one concurrent global call must succeed");
      assert.equal(limitErrors.length, 1, "exactly one concurrent global call must get GatewayLimitError");

      // Verify the error references the global (daily_call) limit, not the feature limit.
      if (limitErrors[0]?.status === "rejected") {
        const errMsg = (limitErrors[0].reason as GatewayLimitError).message.toLowerCase();
        assert.ok(
          errMsg.includes("daily") || errMsg.includes("limit"),
          `GatewayLimitError must cite a limit, got: ${errMsg}`,
        );
      }
    });
  });

  // ── Abort / cancellation terminal status in ai_usage_log ──────────────────

  describe("abort/cancellation: terminal status in ai_usage_log", () => {
    it("AbortError from provider produces a 'failed' log entry with errorCode='AbortError'", async () => {
      // Mock the provider to throw AbortError unconditionally.
      // This simulates a cancelled request reaching the completion layer.
      __setOpenAICompletionForTesting(async () => {
        throw new DOMException("This operation was aborted", "AbortError");
      });

      const before = new Date(Date.now() - 100);
      let threw = false;

      try {
        await invokeAI({
          feature:   "requirements_extraction",
          messages:  [{ role: "user", content: "abort terminal status test" }],
          maxTokens: 10,
        });
      } catch (err) {
        threw = true;
        assert.ok(
          err instanceof DOMException && err.name === "AbortError",
          `expected DOMException(AbortError), got: ${err}`,
        );
      }

      assert.ok(threw, "invokeAI must propagate the AbortError");

      // logFail() is called as void (fire-and-forget), so give it time to settle.
      await new Promise((r) => setTimeout(r, 150));

      // Find the most-recent failed log entry written after the test started.
      const logs = await db
        .select({
          status:    aiUsageLogTable.status,
          errorCode: aiUsageLogTable.errorCode,
        })
        .from(aiUsageLogTable)
        .where(
          and(
            eq(aiUsageLogTable.status,    "failed"),
            eq(aiUsageLogTable.errorCode, "AbortError"),
            gte(aiUsageLogTable.startedAt, before),
          ),
        )
        .orderBy(desc(aiUsageLogTable.id))
        .limit(1);

      assert.ok(logs.length > 0,       "must have at least one 'failed/AbortError' log entry");
      assert.equal(logs[0]!.status,    "failed",     "log status must be 'failed'");
      assert.equal(logs[0]!.errorCode, "AbortError", "errorCode must be 'AbortError'");
    });
  });
});
