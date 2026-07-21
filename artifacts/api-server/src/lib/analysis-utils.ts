// ── Pure helpers for the opportunity analysis pipeline ───────────────────────
// No database or OpenAI imports — these are fully unit-testable.

/** ≈ 12 000 tokens at 3.75 chars/token average for English prose */
export const MAX_INPUT_CHARS = 45_000;
/** First two-thirds of the budget (covers scope, objectives, background) */
export const HEAD_CHARS = 30_000;
/** Last one-third of the budget (covers appendices, submission instructions) */
export const TAIL_CHARS = 15_000;

export const EXTRACTION_MAX_TOKENS = 1_500;
export const MAX_REQUIREMENTS = 40;
export const MAX_REQ_CHARS = 250;
export const ANALYSIS_TIMEOUT_MS = 90_000;
export const STALE_JOB_MS = 5 * 60 * 1_000;

export const ANALYSIS_ACTIVE_STATUSES = [
  "analysing",
  "requirements_extracting",
  "bid_scoring",
  "strategy_generating",
] as const;

export type AnalysisActiveStatus = (typeof ANALYSIS_ACTIVE_STATUSES)[number];

export type ErrorCode =
  | "insufficient_quota"
  | "timeout"
  | "rate_limit_exceeded"
  | "network"
  | "abandoned"
  | "unknown";

// ── Text budget ───────────────────────────────────────────────────────────────

/**
 * Truncate `text` to fit within the AI token budget while preserving the
 * beginning (scope/background) and end (submission instructions/appendices).
 */
export function truncateToTokenBudget(
  text: string,
  maxChars = MAX_INPUT_CHARS,
): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * (2 / 3));
  const tail = maxChars - head;
  return (
    text.slice(0, head) +
    "\n\n[… document truncated for processing — middle section omitted to stay within analysis limits …]\n\n" +
    text.slice(-tail)
  );
}

// ── Error classification ──────────────────────────────────────────────────────

export function isQuotaError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err);
  return (
    msg.includes("insufficient_quota") ||
    msg.includes("exceeded your current quota")
  );
}

export function isTemporaryRateLimitError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err);
  return (
    (msg.includes("rate_limit_exceeded") ||
      msg.includes("rate limit") ||
      msg.includes("too many requests")) &&
    !isQuotaError(err)
  );
}

export function isNetworkError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err);
  return (
    msg.includes("ECONNRESET") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("fetch failed") ||
    msg.includes("network error")
  );
}

export function isTimeoutError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err);
  return (
    msg.includes("timed out after 90s") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

/**
 * Returns true for errors that warrant a single retry.
 * Quota exhaustion is NEVER retryable — wasting a retry call on a drained
 * account just burns more tokens and delays the failure.
 */
export function isRetryable(err: unknown): boolean {
  if (isQuotaError(err)) return false;
  return isTemporaryRateLimitError(err) || isNetworkError(err);
}

export function classifyError(err: unknown): { code: ErrorCode; message: string } {
  const message = String(err instanceof Error ? err.message : err);
  if (isQuotaError(err)) return { code: "insufficient_quota", message };
  if (isTimeoutError(err)) return { code: "timeout", message };
  if (isTemporaryRateLimitError(err)) return { code: "rate_limit_exceeded", message };
  if (isNetworkError(err)) return { code: "network", message };
  return { code: "unknown", message };
}

// ── Retry wrapper ─────────────────────────────────────────────────────────────

/**
 * Calls `fn` once. On a retryable error (temporary rate-limit or network blip),
 * waits `retryDelayMs` and tries exactly once more. Quota errors re-throw
 * immediately with no retry. Pass `retryDelayMs = 0` in unit tests.
 */
// ── Step ordering (for resume logic) ─────────────────────────────────────────

export type AnalysisStep =
  | "requirements_extracting"
  | "bid_scoring"
  | "strategy_generating";

/** Canonical execution order. */
export const ANALYSIS_STEP_ORDER: readonly AnalysisStep[] = [
  "requirements_extracting",
  "bid_scoring",
  "strategy_generating",
] as const;

/**
 * Given the set of already-completed step names (from the DB column), returns
 * the first step that has not yet succeeded — i.e. where a resumed run
 * should begin. Returns `null` when all applicable steps are done.
 *
 * @param completedSteps - Steps that succeeded in the current or prior run.
 * @param skipStrategy   - `true` when the latest bid score is `no_bid`;
 *                         strategy generation is intentionally skipped.
 */
export function getFirstIncompleteStep(
  completedSteps: string[],
  skipStrategy = false,
): AnalysisStep | null {
  const done = new Set(completedSteps);
  for (const step of ANALYSIS_STEP_ORDER) {
    if (step === "strategy_generating" && skipStrategy) continue;
    if (!done.has(step)) return step;
  }
  return null;
}

export async function callWithSingleRetry<T>(
  fn: () => Promise<T>,
  retryDelayMs = 3_000,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isRetryable(err)) throw err;
    console.warn(
      "[ai-call] Retryable error — pausing before one retry:",
      err instanceof Error ? err.message : String(err),
    );
    await new Promise<void>((r) => setTimeout(r, retryDelayMs));
    return fn();
  }
}
