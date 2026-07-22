/**
 * Centralized AI gateway — the ONLY module in the codebase permitted to import
 * from @workspace/integrations-openai-ai-server.
 *
 * All OpenAI calls from routes and pipelines MUST go through invokeAI().
 * Direct imports of openai/AI_MODEL outside this file will fail the build guard
 * (see build.mjs) and code review.
 */
import { openai, AI_MODEL } from "@workspace/integrations-openai-ai-server";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
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
  dailyCalls:  () => envInt("AI_DAILY_CALL_LIMIT",   200),
  dailyTokens: () => envInt("AI_DAILY_TOKEN_LIMIT",  500_000),
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

async function readCircuit(): Promise<CircuitCache> {
  const now = Date.now();
  if (_circuitCache && now - _circuitCache.loadedAt < CIRCUIT_CACHE_TTL_MS) {
    return _circuitCache;
  }
  try {
    const [row] = await db.select().from(aiCircuitTable).where(eq(aiCircuitTable.id, 1));
    _circuitCache = {
      open:      row?.open      ?? false,
      openedAt:  row?.openedAt  ?? null,
      errorCode: row?.errorCode ?? null,
      resetAt:   row?.resetAt   ?? null,
      loadedAt:  now,
    };
  } catch {
    if (!_circuitCache) {
      _circuitCache = { open: false, openedAt: null, errorCode: null, resetAt: null, loadedAt: now };
    }
  }
  return _circuitCache;
}

async function openCircuit(errorCode: string): Promise<void> {
  const now = new Date();
  _circuitCache = { open: true, openedAt: now, errorCode, resetAt: null, loadedAt: Date.now() };
  try {
    await db
      .insert(aiCircuitTable)
      .values({ id: 1, open: true, openedAt: now, errorCode, updatedAt: now })
      .onConflictDoUpdate({
        target: aiCircuitTable.id,
        set: { open: true, openedAt: now, errorCode, updatedAt: now },
      });
  } catch (err) {
    console.error("[ai-gateway] Failed to persist circuit open to DB:", err);
  }
}

/** Admin-only reset — clears circuit in DB and cache. */
export async function resetCircuit(): Promise<void> {
  _circuitCache = { open: false, openedAt: null, errorCode: null, resetAt: null, loadedAt: Date.now() };
  await db
    .insert(aiCircuitTable)
    .values({ id: 1, open: false, openedAt: undefined, errorCode: undefined, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: aiCircuitTable.id,
      set: { open: false, openedAt: null, errorCode: null, updatedAt: new Date() },
    });
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

function startOfTomorrow(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// ── Atomic quota reservation ──────────────────────────────────────────────────
//
// A single SQL statement atomically:
//   1. Counts today's calls and token usage
//   2. Inserts the log row with status = 'pending'  (if within limits)
//                                   or 'limit_exceeded' (if over any limit)
//
// Because it is one statement running under Postgres snapshot isolation,
// concurrent requests cannot both pass the limit check and both insert 'pending'.

interface ReserveResult {
  logId:      number;
  allowed:    boolean;
  globalOk:   boolean;
  featureOk:  boolean;
  tokenOk:    boolean;
}

async function atomicReserveAndLog(opts: {
  requestId:     string;
  feature:       string;
  opportunityId?: number;
  proposalId?:   number;
  operationKey?: string;
  globalLimit:   number;
  featureLimit:  number;
  tokenLimit:    number;
}): Promise<ReserveResult> {
  const {
    requestId, feature, opportunityId, proposalId, operationKey,
    globalLimit, featureLimit, tokenLimit,
  } = opts;

  const oppVal   = opportunityId ?? null;
  const propVal  = proposalId    ?? null;
  const opKeyVal = operationKey  ?? null;

  // Raw SQL CTE: check + insert in one atomic statement.
  //
  // Call limit counts all non-terminal rows (including pending in-flight).
  // Token limit counts only rows that have actual token data (completed calls).
  const result = await db.execute<{
    id:          number;
    status:      string;
    global_ok:   boolean;
    feature_ok:  boolean;
    token_ok:    boolean;
  }>(sql`
    WITH today_stats AS (
      SELECT
        COUNT(*) FILTER (
          WHERE status NOT IN ('limit_exceeded', 'circuit_open')
        )::int AS total_calls,

        COUNT(*) FILTER (
          WHERE feature = ${feature}
            AND status NOT IN ('limit_exceeded', 'circuit_open')
        )::int AS feature_calls,

        COALESCE(SUM(
          COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)
        ) FILTER (
          WHERE status = 'completed'
        ), 0)::int AS total_tokens

      FROM ai_usage_log
      WHERE started_at >= CURRENT_DATE
    ),
    limit_check AS (
      SELECT
        total_calls  < ${globalLimit}  AS global_ok,
        feature_calls < ${featureLimit} AS feature_ok,
        total_tokens  < ${tokenLimit}   AS token_ok
      FROM today_stats
    ),
    ins AS (
      INSERT INTO ai_usage_log
        (request_id, feature, opportunity_id, proposal_id, operation_key, status)
      SELECT
        ${requestId},
        ${feature},
        ${oppVal},
        ${propVal},
        ${opKeyVal},
        CASE WHEN global_ok AND feature_ok AND token_ok
             THEN 'pending'
             ELSE 'limit_exceeded'
        END
      FROM limit_check
      RETURNING id, status
    )
    SELECT
      ins.id,
      ins.status,
      lc.global_ok,
      lc.feature_ok,
      lc.token_ok
    FROM ins, limit_check lc
  `);

  const row = result.rows[0];
  if (!row) throw new Error("[ai-gateway] atomicReserveAndLog: no row returned — DB error");

  const allowed = row.status === "pending";
  return {
    logId:     row.id,
    allowed,
    globalOk:  Boolean(row.global_ok),
    featureOk: Boolean(row.feature_ok),
    tokenOk:   Boolean(row.token_ok),
  };
}

// ── Log completion helpers ────────────────────────────────────────────────────

async function logComplete(logId: number, result: AIResult): Promise<void> {
  try {
    await db.update(aiUsageLogTable).set({
      status:      "completed",
      completedAt: new Date(),
      model:       result.model,
      inputTokens:  result.usage?.promptTokens     ?? null,
      outputTokens: result.usage?.completionTokens ?? null,
    }).where(eq(aiUsageLogTable.id, logId));
  } catch { /* non-critical */ }
}

async function logFail(logId: number, errorCode: string): Promise<void> {
  try {
    await db.update(aiUsageLogTable).set({
      status:      "failed",
      completedAt: new Date(),
      errorCode,
    }).where(eq(aiUsageLogTable.id, logId));
  } catch { /* non-critical */ }
}

/** Log a circuit_open attempt (no prior pending row exists for this call). */
async function logCircuitOpen(opts: {
  feature:       string;
  opportunityId?: number;
  proposalId?:   number;
  operationKey?: string;
}): Promise<void> {
  try {
    await db.insert(aiUsageLogTable).values({
      requestId:     crypto.randomUUID(),
      feature:       opts.feature,
      opportunityId: opts.opportunityId ?? null,
      proposalId:    opts.proposalId    ?? null,
      operationKey:  opts.operationKey  ?? null,
      status:        "circuit_open",
      completedAt:   new Date(),
      errorCode:     "circuit_open",
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

// ── Core gateway function ─────────────────────────────────────────────────────

/**
 * The single, enforced entry point for all OpenAI calls.
 *
 * Behaviour:
 *  - Validates feature against the allowlist.
 *  - Checks DB-backed circuit (cached 30 s); rejects if open (logs circuit_open).
 *  - Atomically reserves a usage-log slot and checks call/token/per-feature limits;
 *    rejects with GatewayLimitError if any limit is exceeded (logged as limit_exceeded).
 *  - On quota exhaustion: opens DB circuit, logs failure, never retries.
 *  - On rate-limit + permitRetry: waits Retry-After (≤60 s) and retries once.
 *    If that retry also hits quota, opens circuit before re-throwing.
 *
 * @throws {GatewayFeatureError}     unknown feature name
 * @throws {GatewayCircuitOpenError} quota circuit is open
 * @throws {GatewayLimitError}       daily call/token limit reached
 * @throws                           any other OpenAI / network error
 */
export async function invokeAI(params: InvokeAIParams): Promise<AIResult> {
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

  // ① DB-backed circuit check (cached 30 s)
  const circuit = await readCircuit();
  if (circuit.open) {
    void logCircuitOpen({ feature, opportunityId, proposalId, operationKey });
    throw new GatewayCircuitOpenError(circuit.openedAt, circuit.resetAt);
  }

  // ② Atomic quota reservation — single SQL statement (check + insert)
  const reserve = await atomicReserveAndLog({
    requestId:    crypto.randomUUID(),
    feature,
    opportunityId,
    proposalId,
    operationKey,
    globalLimit:  LIMITS.dailyCalls(),
    featureLimit: LIMITS.perFeature[feature]?.() ?? 100,
    tokenLimit:   LIMITS.dailyTokens(),
  });

  if (!reserve.allowed) {
    const tomorrow = startOfTomorrow();
    const reason = !reserve.globalOk
      ? `global daily call limit (${LIMITS.dailyCalls()}) reached`
      : !reserve.featureOk
        ? `per-feature daily limit for "${feature}" (${LIMITS.perFeature[feature]?.() ?? 100}) reached`
        : `daily token limit (${LIMITS.dailyTokens()}) reached`;
    throw new GatewayLimitError(reason, tomorrow);
  }

  const logId = reserve.logId;
  const ctx = [
    feature,
    opportunityId != null ? `opp=${opportunityId}` : null,
    proposalId    != null ? `prop=${proposalId}`   : null,
    operationKey  != null ? `op=${operationKey}`   : null,
  ]
    .filter(Boolean)
    .join(" ");

  const callOnce = async (): Promise<AIResult> => {
    const completion = await openai.chat.completions.create(
      {
        model:      AI_MODEL,
        max_tokens: maxTokens,
        ...(responseFormat ? { response_format: responseFormat } : {}),
        messages,
      },
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
    void logComplete(logId, result);
    return result;
  } catch (err) {
    if (isQuotaError(err)) {
      await openCircuit("insufficient_quota");
      console.error(
        `[ai-gateway] quota exhausted — circuit opened (${ctx}). ` +
          "All AI calls blocked until admin resets via POST /api/admin/ai/circuit/reset.",
      );
      void logFail(logId, "insufficient_quota");
      throw err;
    }

    if (isRateLimitError(err) && permitRetry) {
      const delayMs = getRetryAfterMs(err);
      console.warn(`[ai-gateway] rate limited — retrying in ${delayMs} ms (${ctx})`);
      await new Promise<void>((r) => setTimeout(r, delayMs));
      try {
        const result = await callOnce();
        console.info(`[ai-gateway] ok (after retry) — ${ctx}`);
        void logComplete(logId, result);
        return result;
      } catch (retryErr) {
        if (isQuotaError(retryErr)) {
          await openCircuit("insufficient_quota");
          console.error(`[ai-gateway] quota exhausted on retry — circuit opened (${ctx}).`);
        }
        void logFail(logId, retryErr instanceof Error ? retryErr.name : "retry_error");
        throw retryErr;
      }
    }

    console.warn(
      `[ai-gateway] error (${ctx}):`,
      err instanceof Error ? err.message : String(err),
    );
    void logFail(logId, err instanceof Error ? err.name : "unknown");
    throw err;
  }
}
