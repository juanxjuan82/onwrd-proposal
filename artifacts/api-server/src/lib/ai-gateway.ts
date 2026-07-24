/**
 * Centralized AI gateway — the ONLY module in the codebase permitted to import
 * from @workspace/integrations-openai-ai-server.
 *
 * All OpenAI calls from routes and pipelines MUST go through invokeAI().
 * Direct imports of openai/AI_MODEL outside this file will fail the build guard
 * (see build.mjs) and code review.
 */
import { openai, AI_MODEL } from "@workspace/integrations-openai-ai-server";
// Local type alias — avoids a direct `openai` peer-dep on api-server.
// Matches openai's ChatCompletionMessageParam shape.
type ChatCompletionMessageParam = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
};
import { db } from "@workspace/db";
import { aiCircuitTable, aiUsageLogTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

// ── Feature allowlist ─────────────────────────────────────────────────────────

export type GatewayFeature =
  | "requirements_extraction"
  | "strategy_generation"
  | "proposal_generation"
  | "section_regeneration"
  | "proposal_check";

const ALLOWED_FEATURES = new Set<GatewayFeature>([
  "requirements_extraction",
  "strategy_generation",
  "proposal_generation",
  "section_regeneration",
  "proposal_check",
]);

// ── Configurable limits (env vars with sane defaults) ─────────────────────────

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const LIMITS = {
  dailyCalls:    () => envInt("AI_DAILY_CALL_LIMIT",       200),
  dailyTokens:   () => envInt("AI_DAILY_TOKEN_LIMIT",  500_000),
  perOperation:  () => envInt("AI_MAX_CALLS_PER_OPERATION",  50),
  perFeature: {
    requirements_extraction: () => envInt("AI_DAILY_REQUIREMENTS_LIMIT", 100),
    strategy_generation:     () => envInt("AI_DAILY_STRATEGY_LIMIT",     100),
    proposal_generation:     () => envInt("AI_DAILY_PROPOSAL_LIMIT",     100),
    section_regeneration:    () => envInt("AI_DAILY_SECTION_LIMIT",      100),
    proposal_check:          () => envInt("AI_DAILY_CHECK_LIMIT",        100),
  } as Record<GatewayFeature, () => number>,
};

// ── In-process circuit cache (30 s TTL — avoids DB read per call) ─────────────

interface CircuitCache {
  open:      boolean;
  openedAt:  Date | null;
  errorCode: string | null;
  resetAt:   Date | null;
  loadedAt:  number;
}
let _circuitCache: CircuitCache | null = null;
const CIRCUIT_CACHE_TTL_MS = 30_000;

/**
 * Always reads circuit state from DB — used for every AI gating decision so
 * that circuit-open and circuit-reset are immediately effective across all
 * instances (no cache staleness in the hot path).
 * On DB error, fails open to avoid false-blocking calls.
 */
async function readCircuitForGating(): Promise<CircuitCache> {
  const now = Date.now();
  try {
    const [row] = await db.select().from(aiCircuitTable).where(eq(aiCircuitTable.id, 1));

    // Auto-expire circuit if cooldown has elapsed
    if (row?.open && row?.resetAt && row.resetAt < new Date()) {
      console.info("[ai-gateway] Circuit cooldown expired — auto-resetting.");
      await _doResetCircuit();
      _circuitCache = { open: false, openedAt: null, errorCode: null, resetAt: null, loadedAt: now };
      return _circuitCache;
    }

    _circuitCache = {
      open:      row?.open      ?? false,
      openedAt:  row?.openedAt  ?? null,
      errorCode: row?.errorCode ?? null,
      resetAt:   row?.resetAt   ?? null,
      loadedAt:  now,
    };
  } catch {
    // DB unreachable — fail open so a DB hiccup doesn't block all AI calls.
    // Use stale cache if available; otherwise synthesise a closed state.
    if (!_circuitCache) {
      _circuitCache = { open: false, openedAt: null, errorCode: null, resetAt: null, loadedAt: now };
    }
    console.warn("[ai-gateway] DB error reading circuit — using cached/open-fail-safe state.");
  }
  return _circuitCache;
}

/**
 * Reads circuit state for admin/status endpoints (cached 30 s).
 * Do NOT use this for the AI gating decision — use readCircuitForGating().
 */
async function readCircuit(): Promise<CircuitCache> {
  const now = Date.now();
  if (_circuitCache && now - _circuitCache.loadedAt < CIRCUIT_CACHE_TTL_MS) {
    return _circuitCache;
  }
  return readCircuitForGating();
}

async function _doResetCircuit(): Promise<void> {
  await db
    .insert(aiCircuitTable)
    .values({ id: 1, open: false, openedAt: undefined, errorCode: undefined, resetAt: undefined, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: aiCircuitTable.id,
      set: { open: false, openedAt: null, errorCode: null, resetAt: null, updatedAt: new Date() },
    });
}

async function openCircuit(errorCode: string): Promise<void> {
  const now = new Date();
  const cooldownMs = envInt("AI_CIRCUIT_COOLDOWN_HOURS", 24) * 3_600_000;
  const resetAt    = new Date(now.getTime() + cooldownMs);
  _circuitCache = { open: true, openedAt: now, errorCode, resetAt, loadedAt: Date.now() };
  try {
    await db
      .insert(aiCircuitTable)
      .values({ id: 1, open: true, openedAt: now, errorCode, resetAt, updatedAt: now })
      .onConflictDoUpdate({
        target: aiCircuitTable.id,
        set: { open: true, openedAt: now, errorCode, resetAt, updatedAt: now },
      });
  } catch (err) {
    console.error("[ai-gateway] Failed to persist circuit open to DB:", err);
  }
}

/** Admin-only reset — clears circuit in DB and invalidates cache. */
export async function resetCircuit(): Promise<void> {
  _circuitCache = { open: false, openedAt: null, errorCode: null, resetAt: null, loadedAt: Date.now() };
  await _doResetCircuit();
}

export async function getCircuitState(): Promise<{
  open:      boolean;
  openedAt:  Date | null;
  errorCode: string | null;
  resetAt:   Date | null;
}> {
  const c = await readCircuit();
  return { open: c.open, openedAt: c.openedAt, errorCode: c.errorCode, resetAt: c.resetAt };
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function todayKey(): string {
  return new Date().toISOString().split("T")[0]!; // YYYY-MM-DD UTC
}

function startOfTomorrow(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// ── Transactional quota reservation ──────────────────────────────────────────
//
// Uses SELECT ... FOR UPDATE on dedicated daily-quota counter rows so
// concurrent requests are serialised through the lock — only one can check
// counts and increment at a time, making it impossible to exceed any limit
// by more than zero regardless of concurrency.
//
// Lock order is always: global → feature → operation (alphabetically within
// each prefix tier) to prevent deadlocks.

interface ReserveResult {
  logId:           number;
  allowed:         boolean;
  globalOk:        boolean;
  featureOk:       boolean;
  tokenOk:         boolean;
  opOk:            boolean;
  /** Tokens reserved in the global quota row for this call (= maxTokens). */
  estimatedTokens: number;
}

async function atomicReserveAndLog(opts: {
  requestId:       string;
  feature:         string;
  opportunityId?:  number;
  proposalId?:     number;
  operationKey?:   string;
  globalLimit:     number;
  featureLimit:    number;
  tokenLimit:      number;
  opLimit:         number;
  /** Conservative upper-bound token budget for this call (= maxTokens param). */
  estimatedTokens: number;
}): Promise<ReserveResult> {
  const { requestId, feature, opportunityId, proposalId, operationKey,
          globalLimit, featureLimit, tokenLimit, opLimit, estimatedTokens } = opts;
  const today   = todayKey();
  const oppVal  = opportunityId ?? null;
  const propVal = proposalId    ?? null;
  const opVal   = operationKey  ?? null;

  // Scopes locked — always in the same order to avoid deadlock
  const scopes = ["global", `feature:${feature}`];
  if (operationKey) scopes.push(`op:${operationKey}`);
  scopes.sort(); // deterministic order — also avoids SELECT FOR UPDATE deadlocks

  // Build an IN-list SQL fragment for all scope values.
  // Drizzle expands a raw JS array as a row-constructor tuple (v1, v2) which
  // is invalid inside ANY().  Using sql.join produces valid IN ($1, $2, …).
  const inScopes = sql.join(scopes.map((s) => sql`${s}`), sql`, `);

  return db.transaction(async (tx) => {
    // 1. Ensure counter rows exist (ON CONFLICT DO NOTHING is safe to run
    //    outside the lock; if two transactions race here only one inserts)
    for (const scope of scopes) {
      await tx.execute(sql`
        INSERT INTO ai_daily_quota (date, scope, calls, tokens)
        VALUES (${today}, ${scope}, 0, 0)
        ON CONFLICT (date, scope) DO NOTHING
      `);
    }

    // 2. Lock all relevant rows in the same deterministic order
    const locked = await tx.execute<{ scope: string; calls: number; tokens: number }>(sql`
      SELECT scope, calls, tokens
      FROM ai_daily_quota
      WHERE date = ${today} AND scope IN (${inScopes})
      ORDER BY scope
      FOR UPDATE
    `);

    const by: Record<string, { calls: number; tokens: number }> = {};
    for (const r of locked.rows) {
      by[r.scope] = { calls: Number(r.calls), tokens: Number(r.tokens) };
    }

    const globalCalls  = by["global"]?.calls  ?? 0;
    const globalTokens = by["global"]?.tokens ?? 0;
    const featCalls    = by[`feature:${feature}`]?.calls ?? 0;
    const opCalls      = operationKey ? (by[`op:${operationKey}`]?.calls ?? 0) : 0;

    const globalOk  = globalCalls  < globalLimit;
    const featureOk = featCalls    < featureLimit;
    // Token check: ensure reserved + estimated budget fits within limit so that
    // concurrent calls can never jointly overshoot the token budget.
    const tokenOk   = globalTokens + estimatedTokens <= tokenLimit;
    const opOk      = !operationKey || opCalls < opLimit;
    const allowed   = globalOk && featureOk && tokenOk && opOk;

    if (!allowed) {
      const errorCode = !globalOk
        ? "daily_call_limit"
        : !featureOk
          ? `feature_limit:${feature}`
          : !tokenOk
            ? "token_limit"
            : `op_limit:${operationKey}`;
      const limitResult = await tx.execute<{ id: number }>(sql`
        INSERT INTO ai_usage_log
          (request_id, feature, opportunity_id, proposal_id, operation_key,
           status, completed_at, error_code)
        VALUES
          (${requestId}, ${feature}, ${oppVal}, ${propVal}, ${opVal},
           'limit_exceeded', NOW(), ${errorCode})
        RETURNING id
      `);
      const limitRow = limitResult.rows[0];
      return { logId: Number(limitRow!.id), allowed: false, globalOk, featureOk, tokenOk, opOk, estimatedTokens: 0 };
    }

    // 3. Increment call counters for all locked scopes AND pre-reserve estimated
    //    tokens for the global scope — this prevents concurrent callers from
    //    seeing the same available budget and jointly exceeding the token limit.
    await tx.execute(sql`
      UPDATE ai_daily_quota
      SET calls = calls + 1, updated_at = NOW()
      WHERE date = ${today} AND scope IN (${inScopes})
    `);
    await tx.execute(sql`
      UPDATE ai_daily_quota
      SET tokens = tokens + ${estimatedTokens}, updated_at = NOW()
      WHERE date = ${today} AND scope = 'global'
    `);

    // 4. Insert pending log row
    const logResult = await tx.execute<{ id: number }>(sql`
      INSERT INTO ai_usage_log
        (request_id, feature, opportunity_id, proposal_id, operation_key, status)
      VALUES
        (${requestId}, ${feature}, ${oppVal}, ${propVal}, ${opVal}, 'pending')
      RETURNING id
    `);
    const logRow = logResult.rows[0];

    return {
      logId:           Number(logRow!.id),
      allowed:         true,
      globalOk:        true,
      featureOk:       true,
      tokenOk:         true,
      opOk:            true,
      estimatedTokens,
    };
  });
}

// ── Token accounting — correct pre-reserved estimate to actual usage ──────────
//
// At reservation time we pre-reserved `estimatedTokens` (= maxTokens) in the
// global ai_daily_quota row so concurrent calls see the reserved budget.
// After the call we correct the running total:
//   • on success: tokens += (actualTotal - estimatedTokens)  — may be negative
//   • on failure: tokens -= estimatedTokens                  — release reservation
//
// This keeps the global token counter accurate without ever allowing overruns.

async function correctTokenReservation(delta: number): Promise<void> {
  if (!delta) return;
  try {
    const today = todayKey();
    await db.execute(sql`
      UPDATE ai_daily_quota
      SET tokens = GREATEST(0, tokens + ${delta}), updated_at = NOW()
      WHERE date = ${today} AND scope = 'global'
    `);
  } catch { /* non-critical — the conservative reservation still stands */ }
}

// ── Log completion helpers ────────────────────────────────────────────────────

async function logComplete(logId: number, estimatedTokens: number, result: AIResult): Promise<void> {
  try {
    await db.update(aiUsageLogTable).set({
      status:      "completed",
      completedAt: new Date(),
      model:       result.model,
      inputTokens:  result.usage?.promptTokens     ?? null,
      outputTokens: result.usage?.completionTokens ?? null,
    }).where(eq(aiUsageLogTable.id, logId));
    // Correct the pre-reserved budget: add actual tokens, subtract the estimate.
    const actualTotal = result.usage?.totalTokens ?? 0;
    void correctTokenReservation(actualTotal - estimatedTokens);
  } catch { /* non-critical */ }
}

async function logFail(logId: number, estimatedTokens: number, errorCode: string): Promise<void> {
  try {
    await db.update(aiUsageLogTable).set({
      status:      "failed",
      completedAt: new Date(),
      errorCode,
    }).where(eq(aiUsageLogTable.id, logId));
    // Release the pre-reserved token budget — the call never consumed tokens.
    void correctTokenReservation(-estimatedTokens);
  } catch { /* non-critical */ }
}

/** Log a circuit_open attempt (fired before the circuit error is thrown). */
async function logCircuitOpen(opts: {
  feature:        string;
  opportunityId?: number;
  proposalId?:    number;
  operationKey?:  string;
}): Promise<void> {
  try {
    await db.insert(aiUsageLogTable).values({
      requestId:    crypto.randomUUID(),
      feature:      opts.feature,
      opportunityId: opts.opportunityId ?? null,
      proposalId:   opts.proposalId    ?? null,
      operationKey: opts.operationKey  ?? null,
      status:       "circuit_open",
      completedAt:  new Date(),
      errorCode:    "circuit_open",
    });
  } catch { /* non-critical */ }
}

// ── Public error classes ──────────────────────────────────────────────────────

export class GatewayCircuitOpenError extends Error {
  public readonly openedAt: Date | null;
  public readonly resetAt:  Date | null;

  constructor(openedAt: Date | null, resetAt?: Date | null) {
    super(
      `AI gateway circuit open (quota exhausted at ${openedAt?.toISOString() ?? "unknown"}). ` +
        `An admin must reset the circuit before AI features resume.`,
    );
    this.name     = "GatewayCircuitOpenError";
    this.openedAt = openedAt;
    this.resetAt  = resetAt ?? null;
  }
}

export class GatewayFeatureError extends Error {
  constructor(feature: string) {
    super(
      `Unknown AI feature: "${feature}". ` +
        `Allowed: ${[...ALLOWED_FEATURES].join(", ")}.`,
    );
    this.name = "GatewayFeatureError";
  }
}

export class GatewayLimitError extends Error {
  constructor(reason: string, public readonly resetAt: Date) {
    super(`AI daily limit reached: ${reason}. Resets at ${resetAt.toISOString()}.`);
    this.name = "GatewayLimitError";
  }
}

// ── Result type ───────────────────────────────────────────────────────────────

export interface AIResult {
  /** Raw content string from choices[0].message.content (never null). */
  content: string;
  /** Model ID returned by the API (e.g. "gpt-4o"). */
  model: string;
  /** Token usage — undefined if the API omitted it. */
  usage?: {
    promptTokens:     number;
    completionTokens: number;
    totalTokens:      number;
  };
}

// ── Invoke params ─────────────────────────────────────────────────────────────

export interface InvokeAIParams {
  feature: GatewayFeature;
  messages: ChatCompletionMessageParam[];
  maxTokens: number;
  responseFormat?: { type: "json_object" };
  signal?: AbortSignal;
  permitRetry?: boolean;
  opportunityId?: number;
  proposalId?:    number;
  operationKey?:  string;
}

// ── Error helpers ─────────────────────────────────────────────────────────────

function isQuotaError(err: unknown): boolean {
  const e = err as { status?: number; code?: string; message?: string };
  if (e?.status === 402 || e?.code === "insufficient_quota") return true;
  const msg = String(e?.message ?? "");
  return (
    msg.includes("insufficient_quota") ||
    msg.includes("exceeded your current quota")
  );
}

function isRateLimitError(err: unknown): boolean {
  if (isQuotaError(err)) return false;
  const e = err as { status?: number; message?: string };
  if (e?.status === 429) return true;
  const msg = String(e?.message ?? "");
  return (
    msg.includes("rate_limit_exceeded") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests")
  );
}

/** Returns the Retry-After delay in ms, capped at 60 s. Defaults to 5 s. */
function getRetryAfterMs(err: unknown): number {
  const e = err as {
    headers?: Record<string, string>;
    response?: { headers?: Record<string, string> };
  };
  const raw =
    e?.headers?.["retry-after"] ?? e?.response?.headers?.["retry-after"];
  if (!raw) return 5_000;
  const secs = Number(raw);
  return isNaN(secs) ? 5_000 : Math.min(secs * 1_000, 60_000);
}

// ── Test-double hook ──────────────────────────────────────────────────────────
// Allows test suites to intercept every invokeAI() call without ESM module
// replacement or process-level mocking.  Always null in production.
// Import __setInvokeAISpy only from *.test.ts files.
let _invokeAISpy: ((params: InvokeAIParams) => Promise<AIResult>) | null = null;

/**
 * FOR TESTING ONLY — swap in a test double for every invokeAI() call.
 * The gateway's circuit, quota, and DB logic are all bypassed.
 * Pass null to restore the real implementation.
 */
export function __setInvokeAISpy(
  spy: ((params: InvokeAIParams) => Promise<AIResult>) | null,
): void {
  _invokeAISpy = spy;
}

// ── OpenAI completion mock (test only) ───────────────────────────────────────
// Replaces openai.chat.completions.create inside callOnce().
// The gateway still runs all surrounding logic: circuit, quota, DB writes.
// Always null in production. Import __setOpenAICompletionForTesting only in *.test.ts files.
export type MinimalCompletion = {
  choices: Array<{ message: { content: string | null } }>;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
};
let _mockCompletionFn:
  | ((body: Record<string, unknown>, opts?: { signal?: AbortSignal }) => Promise<MinimalCompletion>)
  | null = null;

/**
 * FOR TESTING ONLY — replace openai.chat.completions.create inside invokeAI().
 * The gateway still runs all logic (circuit, quota, DB writes) around this call.
 * Pass null to restore real OpenAI calls.
 */
export function __setOpenAICompletionForTesting(
  fn:
    | ((body: Record<string, unknown>, opts?: { signal?: AbortSignal }) => Promise<MinimalCompletion>)
    | null,
): void {
  _mockCompletionFn = fn;
}

// ── Core gateway function ─────────────────────────────────────────────────────

/**
 * The single, enforced entry point for all OpenAI calls.
 *
 * Behaviour:
 *  - Validates feature against the allowlist.
 *  - Checks DB-backed circuit (cached 30 s; auto-expires after AI_CIRCUIT_COOLDOWN_HOURS);
 *    rejects if open (logs circuit_open row).
 *  - Atomically reserves a quota slot via SELECT FOR UPDATE on ai_daily_quota counter rows,
 *    enforcing: global daily call limit (AI_DAILY_CALL_LIMIT), per-feature limit,
 *    global daily token limit (AI_DAILY_TOKEN_LIMIT), and per-operation limit
 *    (AI_MAX_CALLS_PER_OPERATION when operationKey is provided).
 *    Concurrent callers are serialised through the DB lock — overrun by more than
 *    zero is not possible.
 *  - On quota exhaustion: opens DB circuit with cooldown, logs failure, never retries.
 *  - On rate-limit + permitRetry: waits Retry-After (≤60 s) and retries once.
 *    If that retry also hits quota, opens circuit before re-throwing.
 *
 * @throws {GatewayFeatureError}     unknown feature name
 * @throws {GatewayCircuitOpenError} quota circuit is open
 * @throws {GatewayLimitError}       daily/per-op call or token limit reached
 * @throws                           any other OpenAI / network error
 */
export async function invokeAI(params: InvokeAIParams): Promise<AIResult> {
  // Test double: completely short-circuits gateway logic (DB, circuit, quota).
  if (_invokeAISpy) return _invokeAISpy(params);

  const {
    feature,
    messages,
    maxTokens,
    responseFormat,
    signal,
    permitRetry = false,
    opportunityId,
    proposalId,
    operationKey,
  } = params;

  if (!ALLOWED_FEATURES.has(feature)) throw new GatewayFeatureError(feature);

  // ① DB-backed circuit check — always reads DB so open/reset is globally
  //    effective immediately across all instances (no cache in the hot path).
  const circuit = await readCircuitForGating();
  if (circuit.open) {
    void logCircuitOpen({ feature, opportunityId, proposalId, operationKey });
    throw new GatewayCircuitOpenError(circuit.openedAt, circuit.resetAt);
  }

  // ② Atomic quota reservation (SELECT FOR UPDATE in transaction).
  //    estimatedTokens = maxTokens is pre-reserved in the global token counter
  //    so concurrent callers cannot jointly overshoot the token budget.
  const reserve = await atomicReserveAndLog({
    requestId:       crypto.randomUUID(),
    feature,
    opportunityId,
    proposalId,
    operationKey,
    globalLimit:     LIMITS.dailyCalls(),
    featureLimit:    LIMITS.perFeature[feature]?.() ?? 100,
    tokenLimit:      LIMITS.dailyTokens(),
    opLimit:         LIMITS.perOperation(),
    estimatedTokens: maxTokens,
  });

  if (!reserve.allowed) {
    const tomorrow = startOfTomorrow();
    const reason = !reserve.globalOk
      ? `global daily call limit (${LIMITS.dailyCalls()}) reached`
      : !reserve.featureOk
        ? `per-feature daily limit for "${feature}" (${LIMITS.perFeature[feature]?.() ?? 100}) reached`
        : !reserve.tokenOk
          ? `daily token limit (${LIMITS.dailyTokens()}) reached`
          : `per-operation limit (${LIMITS.perOperation()}) reached for operation "${operationKey}"`;
    throw new GatewayLimitError(reason, tomorrow);
  }

  const logId           = reserve.logId;
  const estimatedTokens = reserve.estimatedTokens;
  const ctx = [
    feature,
    opportunityId != null ? `opp=${opportunityId}` : null,
    proposalId    != null ? `prop=${proposalId}`   : null,
    operationKey  != null ? `op=${operationKey}`   : null,
  ]
    .filter(Boolean)
    .join(" ");

  const callOnce = async (): Promise<AIResult> => {
    const createFn =
      _mockCompletionFn ??
      openai.chat.completions.create.bind(openai.chat.completions);
    const completion = await createFn(
      {
        model:      AI_MODEL,
        max_tokens: maxTokens,
        ...(responseFormat ? { response_format: responseFormat } : {}),
        messages,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      signal ? { signal } : undefined,
    );
    const u = completion.usage;
    return {
      content: completion.choices[0]?.message?.content ?? "",
      model:   completion.model,
      usage:   u
        ? {
            promptTokens:     u.prompt_tokens,
            completionTokens: u.completion_tokens,
            totalTokens:      u.total_tokens,
          }
        : undefined,
    };
  };

  try {
    const result = await callOnce();
    console.info(`[ai-gateway] ok — ${ctx}`);
    void logComplete(logId, estimatedTokens, result);
    return result;
  } catch (err) {
    if (isQuotaError(err)) {
      await openCircuit("insufficient_quota");
      console.error(
        `[ai-gateway] quota exhausted — circuit opened (${ctx}). ` +
          "All AI calls blocked until admin resets via POST /api/admin/ai/circuit/reset or cooldown expires.",
      );
      void logFail(logId, estimatedTokens, "insufficient_quota");
      throw err;
    }

    if (isRateLimitError(err) && permitRetry) {
      const delayMs = getRetryAfterMs(err);
      console.warn(`[ai-gateway] rate limited — retrying in ${delayMs} ms (${ctx})`);
      await new Promise<void>((r) => setTimeout(r, delayMs));
      try {
        const result = await callOnce();
        console.info(`[ai-gateway] ok (after retry) — ${ctx}`);
        void logComplete(logId, estimatedTokens, result);
        return result;
      } catch (retryErr) {
        if (isQuotaError(retryErr)) {
          await openCircuit("insufficient_quota");
          console.error(`[ai-gateway] quota exhausted on retry — circuit opened (${ctx}).`);
        }
        void logFail(logId, estimatedTokens, retryErr instanceof Error ? retryErr.name : "retry_error");
        throw retryErr;
      }
    }

    console.warn(
      `[ai-gateway] error (${ctx}):`,
      err instanceof Error ? err.message : String(err),
    );
    void logFail(logId, estimatedTokens, err instanceof Error ? err.name : "unknown");
    throw err;
  }
}
