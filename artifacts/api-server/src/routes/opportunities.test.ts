/**
 * Opportunity analysis pipeline — unit tests
 *
 * Runner: node:test (built-in, no extra packages required)
 * Runner: tsx for TypeScript transpilation
 *
 * Pure-function tests (no mocks needed):
 *   truncateToTokenBudget, classifyError, isQuotaError, isRetryable, callWithSingleRetry
 *
 * Behavioural / logic tests (no DB or network calls):
 *   stale-job cutoff timing, duplicate-status guard, active-status set invariants
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  truncateToTokenBudget,
  classifyError,
  isQuotaError,
  isTemporaryRateLimitError,
  isNetworkError,
  isRetryable,
  callWithSingleRetry,
  getFirstIncompleteStep,
  MAX_INPUT_CHARS,
  HEAD_CHARS,
  TAIL_CHARS,
  ANALYSIS_ACTIVE_STATUSES,
  ANALYSIS_STEP_ORDER,
  STALE_JOB_MS,
} from "../lib/analysis-utils.js";

// ── truncateToTokenBudget ─────────────────────────────────────────────────────

describe("truncateToTokenBudget", () => {
  it("returns the original text unchanged when within the limit", () => {
    const text = "a".repeat(MAX_INPUT_CHARS);
    assert.equal(truncateToTokenBudget(text), text);
  });

  it("returns short text unchanged", () => {
    const text = "Hello, world!";
    assert.equal(truncateToTokenBudget(text), text);
  });

  it("truncates oversized text to ≤ MAX_INPUT_CHARS + ellipsis overhead", () => {
    const text   = "x".repeat(MAX_INPUT_CHARS + 10_000);
    const result = truncateToTokenBudget(text);
    assert.ok(result.length <= MAX_INPUT_CHARS + 200, `length was ${result.length}`);
  });

  it("preserves the beginning of an oversized document", () => {
    const head   = "BEGIN".repeat(10_000);
    const tail   = "END".repeat(10_000);
    const result = truncateToTokenBudget(head + tail);
    assert.ok(result.startsWith("BEGIN"), "head not preserved");
  });

  it("preserves the end of an oversized document (submission instructions / appendices)", () => {
    const text   = "A".repeat(HEAD_CHARS + 5_000) + "SUBMISSION_APPENDIX".repeat(800);
    const result = truncateToTokenBudget(text);
    assert.ok(result.includes("SUBMISSION_APPENDIX"), "tail not preserved");
  });

  it("inserts a truncation marker in the middle", () => {
    const text   = "z".repeat(MAX_INPUT_CHARS * 2);
    const result = truncateToTokenBudget(text);
    assert.ok(result.includes("[… document truncated"), "marker missing");
  });

  it("head slice is exactly HEAD_CHARS characters", () => {
    const text      = "H".repeat(HEAD_CHARS) + "T".repeat(TAIL_CHARS + 10_000);
    const result    = truncateToTokenBudget(text);
    const markerIdx = result.indexOf("[… document truncated");
    const headPart  = result.slice(0, markerIdx).trimEnd();
    assert.equal(headPart.length, HEAD_CHARS);
  });

  it("tail slice equals TAIL_CHARS characters of original text end", () => {
    const text      = "H".repeat(HEAD_CHARS + 10_000) + "T".repeat(TAIL_CHARS);
    const result    = truncateToTokenBudget(text);
    const expected  = "T".repeat(TAIL_CHARS);
    assert.ok(result.endsWith(expected), "tail slice mismatch");
  });

  it("respects a custom maxChars override", () => {
    const text   = "a".repeat(200);
    const result = truncateToTokenBudget(text, 100);
    assert.ok(result.length < 200, "not truncated");
    assert.ok(result.includes("[… document truncated"), "marker missing");
  });

  it("a 100 000-char document reduces to ≤ MAX_INPUT_CHARS + overhead", () => {
    const big    = "Lorem ipsum dolor sit amet. ".repeat(3_572); // ~100k chars
    const result = truncateToTokenBudget(big);
    assert.ok(result.length <= MAX_INPUT_CHARS + 200);
    assert.ok(result.includes("[… document truncated"));
  });
});

// ── isQuotaError ──────────────────────────────────────────────────────────────

describe("isQuotaError", () => {
  it("returns true for 'insufficient_quota'", () => {
    assert.equal(isQuotaError(new Error("insufficient_quota, please upgrade")), true);
  });

  it("returns true for 'exceeded your current quota'", () => {
    assert.equal(isQuotaError(new Error("You exceeded your current quota")), true);
  });

  it("returns false for rate-limit errors", () => {
    assert.equal(isQuotaError(new Error("rate_limit_exceeded")), false);
  });

  it("returns false for network errors", () => {
    assert.equal(isQuotaError(new Error("ECONNRESET")), false);
  });

  it("returns false for generic errors", () => {
    assert.equal(isQuotaError(new Error("something went wrong")), false);
  });

  it("accepts a raw string value", () => {
    assert.equal(isQuotaError("insufficient_quota"), true);
  });
});

// ── isTemporaryRateLimitError ─────────────────────────────────────────────────

describe("isTemporaryRateLimitError", () => {
  it("returns true for rate_limit_exceeded", () => {
    assert.equal(isTemporaryRateLimitError(new Error("rate_limit_exceeded")), true);
  });

  it("returns true for 'too many requests'", () => {
    assert.equal(isTemporaryRateLimitError(new Error("too many requests")), true);
  });

  it("returns false when the error is also a quota error", () => {
    assert.equal(isTemporaryRateLimitError(new Error("insufficient_quota")), false);
  });
});

// ── isNetworkError ────────────────────────────────────────────────────────────

describe("isNetworkError", () => {
  it("recognises ECONNRESET", () => {
    assert.equal(isNetworkError(new Error("ECONNRESET")), true);
  });

  it("recognises ETIMEDOUT", () => {
    assert.equal(isNetworkError(new Error("ETIMEDOUT")), true);
  });

  it("recognises fetch failed / network error", () => {
    assert.equal(isNetworkError(new Error("fetch failed — network error")), true);
  });

  it("returns false for quota errors", () => {
    assert.equal(isNetworkError(new Error("insufficient_quota")), false);
  });
});

// ── isRetryable — quota must NEVER be retried ─────────────────────────────────

describe("isRetryable", () => {
  it("returns false for quota exhaustion (billing — do not retry)", () => {
    assert.equal(isRetryable(new Error("insufficient_quota")), false);
    assert.equal(isRetryable(new Error("exceeded your current quota")), false);
  });

  it("returns true for temporary rate-limit errors", () => {
    assert.equal(isRetryable(new Error("rate_limit_exceeded")), true);
    assert.equal(isRetryable(new Error("too many requests")), true);
  });

  it("returns true for network errors", () => {
    assert.equal(isRetryable(new Error("ECONNRESET")), true);
    assert.equal(isRetryable(new Error("ETIMEDOUT")), true);
    assert.equal(isRetryable(new Error("fetch failed — network error")), true);
  });

  it("returns false for unknown errors", () => {
    assert.equal(isRetryable(new Error("JSON parse error")), false);
    assert.equal(isRetryable(new Error("Tender not found")), false);
  });
});

// ── classifyError ─────────────────────────────────────────────────────────────

describe("classifyError", () => {
  it("classifies insufficient_quota", () => {
    const r = classifyError(new Error("insufficient_quota"));
    assert.equal(r.code, "insufficient_quota");
    assert.equal(typeof r.message, "string");
  });

  it("classifies timeout (message contains 'timed out after 90s')", () => {
    assert.equal(classifyError(new Error("AI request timed out after 90s")).code, "timeout");
  });

  it("classifies AbortError as timeout", () => {
    const err = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    assert.equal(classifyError(err).code, "timeout");
  });

  it("classifies rate_limit_exceeded", () => {
    assert.equal(classifyError(new Error("rate_limit_exceeded")).code, "rate_limit_exceeded");
  });

  it("classifies network errors", () => {
    assert.equal(classifyError(new Error("ECONNRESET")).code, "network");
  });

  it("classifies completely unknown errors as 'unknown'", () => {
    assert.equal(classifyError(new Error("something completely unexpected")).code, "unknown");
  });

  it("always returns a string message even for null input", () => {
    const { message } = classifyError(null);
    assert.equal(typeof message, "string");
  });
});

// ── callWithSingleRetry ────────────────────────────────────────────────────────
// Pass retryDelayMs=0 in tests to avoid real 3-second sleeps.

describe("callWithSingleRetry", () => {
  it("returns the result immediately on success", async () => {
    let calls = 0;
    const result = await callWithSingleRetry(async () => { calls++; return "ok"; }, 0);
    assert.equal(result, "ok");
    assert.equal(calls, 1);
  });

  it("retries exactly once on a retryable error then succeeds", async () => {
    let calls = 0;
    const result = await callWithSingleRetry(async () => {
      calls++;
      if (calls === 1) throw new Error("ECONNRESET");
      return "recovered";
    }, 0);
    assert.equal(result, "recovered");
    assert.equal(calls, 2);
  });

  it("does NOT retry quota errors — throws immediately", async () => {
    let calls = 0;
    await assert.rejects(
      () => callWithSingleRetry(async () => { calls++; throw new Error("insufficient_quota"); }, 0),
      /insufficient_quota/,
    );
    assert.equal(calls, 1, "quota error must not trigger a retry");
  });

  it("throws after exhausting the single retry on a retryable error", async () => {
    let calls = 0;
    await assert.rejects(
      () => callWithSingleRetry(async () => { calls++; throw new Error("ECONNRESET"); }, 0),
      /ECONNRESET/,
    );
    assert.equal(calls, 2, "should have tried exactly twice (1 + 1 retry)");
  });

  it("does NOT perform a third attempt after two failures", async () => {
    let calls = 0;
    await assert.rejects(
      () => callWithSingleRetry(async () => {
        calls++;
        throw new Error("ECONNRESET");
      }, 0),
    );
    assert.equal(calls, 2, "no more than original + one retry");
  });
});

// ── STALE_JOB_MS constant ────────────────────────────────────────────────────

describe("STALE_JOB_MS", () => {
  it("equals exactly 5 minutes in milliseconds", () => {
    assert.equal(STALE_JOB_MS, 5 * 60 * 1_000);
  });
});

// ── ANALYSIS_ACTIVE_STATUSES ──────────────────────────────────────────────────

describe("ANALYSIS_ACTIVE_STATUSES", () => {
  it("contains all expected in-progress step names", () => {
    const s = new Set(ANALYSIS_ACTIVE_STATUSES);
    assert.ok(s.has("requirements_extracting"), "missing requirements_extracting");
    assert.ok(s.has("bid_scoring"),             "missing bid_scoring");
    assert.ok(s.has("strategy_generating"),     "missing strategy_generating");
    assert.ok(s.has("analysing"),               "missing analysing (legacy)");
  });

  it("does NOT include terminal/completed statuses", () => {
    const s = new Set(ANALYSIS_ACTIVE_STATUSES);
    assert.ok(!s.has("screened"),          "screened must not be active");
    assert.ok(!s.has("no_bid"),            "no_bid must not be active");
    assert.ok(!s.has("analysis_failed"),   "analysis_failed must not be active");
    assert.ok(!s.has("opportunity_found"), "opportunity_found must not be active");
  });
});

// ── Stale-job cutoff timing ───────────────────────────────────────────────────

describe("stale-job cutoff calculation", () => {
  it("a job started 6 minutes ago is past the cutoff (stale)", () => {
    const startedAt = new Date(Date.now() - 6 * 60 * 1_000);
    const cutoff    = new Date(Date.now() - STALE_JOB_MS);
    assert.ok(startedAt < cutoff, "6-minute-old job should be stale");
  });

  it("a job started 3 minutes ago is NOT past the cutoff (still active)", () => {
    const startedAt = new Date(Date.now() - 3 * 60 * 1_000);
    const cutoff    = new Date(Date.now() - STALE_JOB_MS);
    assert.ok(startedAt >= cutoff, "3-minute-old job should not be stale");
  });
});

// ── Duplicate-click prevention: status guard logic ───────────────────────────

describe("duplicate analysis prevention (status guard)", () => {
  it("returns 409 when status is requirements_extracting (guard logic)", () => {
    const activeStatus = "requirements_extracting";
    const isActive = (ANALYSIS_ACTIVE_STATUSES as readonly string[]).includes(activeStatus);
    assert.ok(isActive, "requirements_extracting should block a second request");
  });

  it("returns 409 when status is bid_scoring", () => {
    const isActive = (ANALYSIS_ACTIVE_STATUSES as readonly string[]).includes("bid_scoring");
    assert.ok(isActive);
  });

  it("returns 409 when status is strategy_generating", () => {
    const isActive = (ANALYSIS_ACTIVE_STATUSES as readonly string[]).includes("strategy_generating");
    assert.ok(isActive);
  });

  it("allows a new analysis when status is analysis_failed", () => {
    const isActive = (ANALYSIS_ACTIVE_STATUSES as readonly string[]).includes("analysis_failed");
    assert.ok(!isActive, "analysis_failed should allow re-analysis");
  });

  it("allows a new analysis when status is screened", () => {
    const isActive = (ANALYSIS_ACTIVE_STATUSES as readonly string[]).includes("screened");
    assert.ok(!isActive, "screened should allow re-analysis");
  });

  it("allows a new analysis when status is opportunity_found", () => {
    const isActive = (ANALYSIS_ACTIVE_STATUSES as readonly string[]).includes("opportunity_found");
    assert.ok(!isActive);
  });

  it("does NOT include analysis_cancelled (cancelled is terminal, not active)", () => {
    const isActive = (ANALYSIS_ACTIVE_STATUSES as readonly string[]).includes("analysis_cancelled");
    assert.ok(!isActive, "analysis_cancelled must not be an active status");
  });

  it("allows a new analysis when status is analysis_cancelled", () => {
    const isActive = (ANALYSIS_ACTIVE_STATUSES as readonly string[]).includes("analysis_cancelled");
    assert.ok(!isActive, "cancelled tender can be re-analysed");
  });
});

// ── ANALYSIS_STEP_ORDER ───────────────────────────────────────────────────────

describe("ANALYSIS_STEP_ORDER", () => {
  it("has exactly 3 steps", () => {
    assert.equal(ANALYSIS_STEP_ORDER.length, 3);
  });

  it("begins with requirements_extracting", () => {
    assert.equal(ANALYSIS_STEP_ORDER[0], "requirements_extracting");
  });

  it("has bid_scoring as the second step", () => {
    assert.equal(ANALYSIS_STEP_ORDER[1], "bid_scoring");
  });

  it("ends with strategy_generating", () => {
    assert.equal(ANALYSIS_STEP_ORDER[2], "strategy_generating");
  });
});

// ── getFirstIncompleteStep ────────────────────────────────────────────────────

describe("getFirstIncompleteStep", () => {
  it("returns requirements_extracting when nothing is complete", () => {
    assert.equal(getFirstIncompleteStep([]), "requirements_extracting");
  });

  it("returns bid_scoring when only requirements are complete", () => {
    assert.equal(getFirstIncompleteStep(["requirements_extracting"]), "bid_scoring");
  });

  it("returns strategy_generating when requirements + bid_scoring are complete", () => {
    assert.equal(getFirstIncompleteStep(["requirements_extracting", "bid_scoring"]), "strategy_generating");
  });

  it("returns null when all three steps are complete", () => {
    assert.equal(
      getFirstIncompleteStep(["requirements_extracting", "bid_scoring", "strategy_generating"]),
      null,
    );
  });

  it("skips strategy_generating when skipStrategy is true", () => {
    assert.equal(
      getFirstIncompleteStep(["requirements_extracting", "bid_scoring"], true),
      null,
    );
  });

  it("returns requirements_extracting even with skipStrategy true when not done", () => {
    assert.equal(getFirstIncompleteStep([], true), "requirements_extracting");
  });

  it("returns bid_scoring even with skipStrategy true when requirements done", () => {
    assert.equal(getFirstIncompleteStep(["requirements_extracting"], true), "bid_scoring");
  });

  it("is order-insensitive — only cares about set membership", () => {
    assert.equal(
      getFirstIncompleteStep(["strategy_generating", "requirements_extracting"]),
      "bid_scoring",
    );
  });

  it("ignores unknown/extra step names without error", () => {
    assert.equal(
      getFirstIncompleteStep(["requirements_extracting", "unknown_step"]),
      "bid_scoring",
    );
  });

  it("handles duplicate entries in completedSteps without throwing", () => {
    assert.equal(
      getFirstIncompleteStep(["requirements_extracting", "requirements_extracting"]),
      "bid_scoring",
    );
  });
});

// ── Cancel/resume eligibility via ANALYSIS_ACTIVE_STATUSES ───────────────────

describe("cancel/resume eligibility", () => {
  it("cancel is valid during requirements_extracting (active step)", () => {
    const cancelTarget = "requirements_extracting";
    assert.ok(
      (ANALYSIS_ACTIVE_STATUSES as readonly string[]).includes(cancelTarget),
      "must be cancellable while extracting requirements",
    );
  });

  it("cancel is valid during bid_scoring", () => {
    assert.ok((ANALYSIS_ACTIVE_STATUSES as readonly string[]).includes("bid_scoring"));
  });

  it("cancel is valid during strategy_generating", () => {
    assert.ok((ANALYSIS_ACTIVE_STATUSES as readonly string[]).includes("strategy_generating"));
  });

  it("resume is valid on analysis_cancelled (terminal, non-active)", () => {
    const status = "analysis_cancelled";
    const isActive = (ANALYSIS_ACTIVE_STATUSES as readonly string[]).includes(status);
    assert.ok(!isActive, "cancelled tender is not active → resume is allowed");
  });

  it("resume is valid on analysis_failed (terminal, non-active)", () => {
    const status = "analysis_failed";
    const isActive = (ANALYSIS_ACTIVE_STATUSES as readonly string[]).includes(status);
    assert.ok(!isActive, "failed tender is not active → resume is allowed");
  });

  it("simultaneous-cancel race: cancelled status is terminal so cancel endpoint returns alreadyCompleted", () => {
    const cancelledStatus = "analysis_cancelled";
    const isStillActive = (ANALYSIS_ACTIVE_STATUSES as readonly string[]).includes(cancelledStatus);
    assert.ok(!isStillActive, "a second cancel on an already-cancelled tender gets alreadyCompleted=true");
  });

  it("simultaneous-complete race: screened status is terminal so cancel endpoint returns alreadyCompleted", () => {
    const screenedStatus = "screened";
    const isStillActive = (ANALYSIS_ACTIVE_STATUSES as readonly string[]).includes(screenedStatus);
    assert.ok(!isStillActive, "cancel arriving after completion gets alreadyCompleted=true");
  });
});
