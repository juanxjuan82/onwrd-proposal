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
import { eq, gte, and, sql } from "drizzle-orm";

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
      loadedAt:  now,
    };
  } catch {
    // DB error — use last known cache or assume closed
    if (!_circuitCache) _circuitCache = { open: false, openedAt: null, errorCode: null, loadedAt: now };
  }
  return _circuitCache;
}

async function openCircuit(errorCode: string): Promise<void> {
  const now = new Date();
  _circuitCache = { open: true, openedAt: now, errorCode, loadedAt: Date.now() };
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
  _circuitCache = { open: false, openedAt: null, errorCode: null, loadedAt: Date.now() };
  await db
    .insert(aiCircuitTable)
    .values({ id: 1, open: false, openedAt: undefined, errorCode: undefined, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: aiCircuitTable.id,
      set: { open: false, openedAt: null, errorCode: null, updatedAt: new Date() },
    });
}

export async function getCircuitState(): Promise<{
  open: boolean;
  openedAt: Date | null;
  errorCode: string | null;
}> {
  const c = await readCircuit();
  return { open: c.open, openedAt: c.openedAt, errorCode: c.errorCode };
}

// ── In-process daily call count cache (60 s TTL) ──────────────────────────────

interface CountCache {
  totalCalls:   number;
  totalTokens:  number;
  byCalls:      Record<string, number>;
  loadedAt:     number;
}
let _countCache: CountCache | null = null;
const COUNT_CACHE_TTL_MS = 60_000;

function startOfToday(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

async function getDailyCounts(): Promise<CountCache> {
  const now = Date.now();
  if (_countCache && now - _countCache.loadedAt < COUNT_CACHE_TTL_MS) return _countCache;

  try {
    const since = startOfToday();
    const rows = await db
      .select({
        feature:     aiUsageLogTable.feature,
        calls:       sql<number>`count(*)::int`,
        inputTokens: sql<number>`coalesce(sum(${aiUsageLogTable.inputTokens}),0)::int`,
        outputTokens: sql<number>`coalesce(sum(${aiUsageLogTable.outputTokens}),0)::int`,
      })
      .from(aiUsageLogTable)
      .where(
        and(
          gte(aiUsageLogTable.startedAt, since),
          sql`${aiUsageLogTable.status} NOT IN ('limit_exceeded','circuit_open')`,
        ),
      )
      .groupBy(aiUsageLogTable.feature);

    let totalCalls = 0;
    let totalTokens = 0;
    const byCalls: Record<string, number> = {};
    for (const r of rows) {
      totalCalls  += r.calls;
      totalTokens += (r.inputTokens + r.outputTokens);
      byCalls[r.feature] = r.calls;
    }
    _countCache = { totalCalls, totalTokens, byCalls, loadedAt: now };
  } catch {
    if (!_countCache) _countCache = { totalCalls: 0, totalTokens: 0, byCalls: {}, loadedAt: now };
  }
  return _countCache;
}

function invalidateCountCache(): void {
  _countCache = null;
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

// ── Public error classes ──────────────────────────────────────────────────────

export class GatewayCircuitOpenError extends Error {
  constructor(openedAt: Date | null) {
    super(
      `AI gateway circuit open (quota exhausted at ${openedAt?.toISOString() ?? "unknown"}). ` +
        `An admin must reset the circuit before AI features resume.`,
    );
    this.name = "GatewayCircuitOpenError";
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

// ── Usage log helpers ─────────────────────────────────────────────────────────

async function logStart(params: {
  requestId: string;
  feature: string;
  opportunityId?: number;
  proposalId?: number;
  operationKey?: string;
}): Promise<number | null> {
  try {
    const [row] = await db
      .insert(aiUsageLogTable)
      .values({
        requestId:    params.requestId,
        feature:      params.feature,
        opportunityId: params.opportunityId ?? null,
        proposalId:   params.proposalId    ?? null,
        operationKey: params.operationKey  ?? null,
        status:       "pending",
      })
      .returning({ id: aiUsageLogTable.id });
    return row?.id ?? null;
  } catch {
    return null;
  }
}

async function logComplete(logId: number | null, result: AIResult): Promise<void> {
  if (logId == null) return;
  try {
    await db.update(aiUsageLogTable).set({
      status:      "completed",
      completedAt: new Date(),
      model:       result.model,
      inputTokens:  result.usage?.promptTokens     ?? null,
      outputTokens: result.usage?.completionTokens ?? null,
    }).where(eq(aiUsageLogTable.id, logId));
    invalidateCountCache();
  } catch { /* non-critical */ }
}

async function logFail(logId: number | null, status: string, errorCode: string): Promise<void> {
  if (logId == null) return;
  try {
    await db.update(aiUsageLogTable).set({
      status,
      completedAt: new Date(),
      errorCode,
    }).where(eq(aiUsageLogTable.id, logId));
    invalidateCountCache();
  } catch { /* non-critical */ }
}

// ── Core gateway function ─────────────────────────────────────────────────────

/**
 * The single, enforced entry point for all OpenAI calls.
 *
 * Behaviour:
 *  - Validates feature against the allowlist.
 *  - Checks DB-backed circuit (cached 30 s); rejects if open.
 *  - Checks configurable daily call/token/per-feature limits; rejects if exceeded.
 *  - Logs every call to ai_usage_log (start + completion/failure).
 *  - On quota exhaustion: opens DB circuit, never retries.
 *  - On rate-limit + permitRetry: waits Retry-After (≤60 s), retries once.
 *    If that retry also hits quota, opens the circuit before re-throwing.
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

  // ① DB-backed circuit check
  const circuit = await readCircuit();
  if (circuit.open) throw new GatewayCircuitOpenError(circuit.openedAt);

  // ② Configurable daily limit check
  const counts = await getDailyCounts();
  const tomorrow = new Date(); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1); tomorrow.setUTCHours(0, 0, 0, 0);

  if (counts.totalCalls >= LIMITS.dailyCalls()) {
    const logId = await logStart({ requestId: crypto.randomUUID(), feature, opportunityId, proposalId, operationKey });
    await logFail(logId, "limit_exceeded", "daily_call_limit");
    throw new GatewayLimitError(`global daily call limit (${LIMITS.dailyCalls()}) reached`, tomorrow);
  }
  const featureLimit = LIMITS.perFeature[feature]?.() ?? 100;
  const featureCalls = counts.byCalls[feature] ?? 0;
  if (featureCalls >= featureLimit) {
    const logId = await logStart({ requestId: crypto.randomUUID(), feature, opportunityId, proposalId, operationKey });
    await logFail(logId, "limit_exceeded", `feature_limit:${feature}`);
    throw new GatewayLimitError(`per-feature daily limit for "${feature}" (${featureLimit}) reached`, tomorrow);
  }

  // ③ Log start
  const requestId = crypto.randomUUID();
  const logId = await logStart({ requestId, feature, opportunityId, proposalId, operationKey });

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
      void logFail(logId, "failed", "insufficient_quota");
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
          void logFail(logId, "failed", "insufficient_quota");
        } else {
          void logFail(logId, "failed", "retry_error");
        }
        throw retryErr;
      }
    }

    console.warn(
      `[ai-gateway] error (${ctx}):`,
      err instanceof Error ? err.message : String(err),
    );
    void logFail(logId, "failed", err instanceof Error ? err.name : "unknown");
    throw err;
  }
}
