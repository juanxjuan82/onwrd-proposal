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

// ── Circuit breaker (module-level; Task #12 promotes this to DB-backed) ───────

let circuitOpen = false;
let circuitOpenedAt: Date | null = null;
let lastErrorCode: string | null = null;

export function isCircuitOpen(): boolean {
  return circuitOpen;
}

export function getCircuitState(): {
  open: boolean;
  openedAt: Date | null;
  lastErrorCode: string | null;
} {
  return { open: circuitOpen, openedAt: circuitOpenedAt, lastErrorCode };
}

/** Admin-only reset — clears the circuit so AI calls are permitted again. */
export function resetCircuit(): void {
  circuitOpen    = false;
  circuitOpenedAt = null;
  lastErrorCode  = null;
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
  /**
   * Pre-composed AbortSignal (e.g. AbortSignal.any([cancel, timeout])).
   * Use when the caller manages cancellation / hard timeout.
   */
  signal?: AbortSignal;
  /**
   * When true: on a temporary rate-limit, wait for the Retry-After header
   * (capped at 60 s) and try exactly once more.
   * Quota errors are NEVER retried regardless of this flag.
   */
  permitRetry?: boolean;
  // Contextual metadata — used for logging now, DB-tracked in Task #12
  opportunityId?: number;
  proposalId?:    number;
  operationKey?:  string;
}

// ── Core gateway function ─────────────────────────────────────────────────────

/**
 * The single, enforced entry point for all OpenAI calls.
 *
 * Behaviour:
 *  - Validates feature against the allowlist.
 *  - Rejects immediately if the quota circuit is open.
 *  - On quota exhaustion: opens the circuit, re-throws (no retry ever).
 *  - On rate-limit + permitRetry: waits Retry-After (≤60 s) and tries once more.
 *
 * @throws {GatewayFeatureError}     — unknown feature name
 * @throws {GatewayCircuitOpenError} — quota circuit is open
 * @throws                           — any other OpenAI / network error
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
  if (circuitOpen) throw new GatewayCircuitOpenError(circuitOpenedAt);

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
    return result;
  } catch (err) {
    if (isQuotaError(err)) {
      circuitOpen     = true;
      circuitOpenedAt = new Date();
      lastErrorCode   = "insufficient_quota";
      console.error(
        `[ai-gateway] quota exhausted — circuit opened (${ctx}). ` +
          "All AI calls blocked until an admin resets the circuit via POST /admin/ai-circuit/reset.",
      );
      throw err;
    }

    if (isRateLimitError(err) && permitRetry) {
      const delayMs = getRetryAfterMs(err);
      console.warn(
        `[ai-gateway] rate limited — retrying in ${delayMs} ms (${ctx})`,
      );
      await new Promise<void>((r) => setTimeout(r, delayMs));
      return callOnce();
    }

    console.warn(
      `[ai-gateway] error (${ctx}):`,
      err instanceof Error ? err.message : String(err),
    );
    throw err;
  }
}
