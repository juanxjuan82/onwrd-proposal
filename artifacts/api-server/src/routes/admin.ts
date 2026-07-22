import { Router, type Request, type Response, type NextFunction } from "express";
import { execSync } from "node:child_process";
import { db } from "@workspace/db";
import { aiUsageLogTable, aiCircuitTable, aiDailyQuotaTable, crawlerRunsTable } from "@workspace/db";
import { eq, gte, and, sql, desc } from "drizzle-orm";
import { resetCircuit, getCircuitState } from "../lib/ai-gateway.js";

const router = Router();

// ── Admin auth guard ─────────────────────────────────────────────────────────
// All /admin/* routes require a bearer token matching ADMIN_API_KEY env var.
// If ADMIN_API_KEY is not set, all admin access is blocked (fail-closed).

function requireAdminKey(req: Request, res: Response, next: NextFunction): void {
  const key = process.env.ADMIN_API_KEY?.trim();
  if (!key) {
    res.status(503).json({
      error: "Admin API key not configured. Set the ADMIN_API_KEY environment variable.",
    });
    return;
  }
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ") || auth.slice(7) !== key) {
    res.status(401).json({ error: "Unauthorized. Provide a valid Bearer token." });
    return;
  }
  next();
}

// Apply auth guard to every route in this router
router.use(requireAdminKey);

// ── GET /api/admin/ai/circuit — inspect circuit state ─────────────────────────
router.get("/ai/circuit", async (_req, res) => {
  try {
    const state = await getCircuitState();
    const [row] = await db.select().from(aiCircuitTable).where(eq(aiCircuitTable.id, 1));
    res.json({
      open:      state.open,
      openedAt:  state.openedAt,
      errorCode: state.errorCode,
      resetAt:   row?.resetAt ?? null,
      updatedAt: row?.updatedAt ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to read circuit state" });
  }
});

// ── POST /api/admin/ai/circuit/reset — close circuit and re-enable AI calls ──
router.post("/ai/circuit/reset", async (_req, res) => {
  try {
    await resetCircuit();
    res.json({ ok: true, message: "Circuit reset. AI calls are now permitted." });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Reset failed" });
  }
});

// ── GET /api/admin/ai/usage — daily usage summary ────────────────────────────
router.get("/ai/usage", async (req, res) => {
  try {
    const days = Math.min(Number(req.query.days ?? "7"), 30);
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - days);
    since.setUTCHours(0, 0, 0, 0);

    const rows = await db
      .select({
        feature:      aiUsageLogTable.feature,
        status:       aiUsageLogTable.status,
        count:        sql<number>`count(*)::int`,
        totalInput:   sql<number>`coalesce(sum(${aiUsageLogTable.inputTokens}),0)::int`,
        totalOutput:  sql<number>`coalesce(sum(${aiUsageLogTable.outputTokens}),0)::int`,
      })
      .from(aiUsageLogTable)
      .where(gte(aiUsageLogTable.startedAt, since))
      .groupBy(aiUsageLogTable.feature, aiUsageLogTable.status)
      .orderBy(aiUsageLogTable.feature, aiUsageLogTable.status);

    const recent = await db
      .select()
      .from(aiUsageLogTable)
      .where(gte(aiUsageLogTable.startedAt, since))
      .orderBy(desc(aiUsageLogTable.startedAt))
      .limit(50);

    res.json({ since: since.toISOString(), summary: rows, recent });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to read usage" });
  }
});

// ── GET /api/admin/ai/usage/today — today's totals only ──────────────────────
router.get("/ai/usage/today", async (_req, res) => {
  try {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const [totals] = await db
      .select({
        totalCalls:   sql<number>`count(*)::int`,
        totalInput:   sql<number>`coalesce(sum(${aiUsageLogTable.inputTokens}),0)::int`,
        totalOutput:  sql<number>`coalesce(sum(${aiUsageLogTable.outputTokens}),0)::int`,
      })
      .from(aiUsageLogTable)
      .where(
        and(
          gte(aiUsageLogTable.startedAt, today),
          sql`${aiUsageLogTable.status} NOT IN ('limit_exceeded','circuit_open')`,
        ),
      );

    const byFeature = await db
      .select({
        feature: aiUsageLogTable.feature,
        calls:   sql<number>`count(*)::int`,
        tokens:  sql<number>`coalesce(sum(${aiUsageLogTable.inputTokens}) + sum(${aiUsageLogTable.outputTokens}),0)::int`,
      })
      .from(aiUsageLogTable)
      .where(
        and(
          gte(aiUsageLogTable.startedAt, today),
          sql`${aiUsageLogTable.status} NOT IN ('limit_exceeded','circuit_open')`,
        ),
      )
      .groupBy(aiUsageLogTable.feature);

    res.json({
      date:       today.toISOString().split("T")[0],
      totalCalls: totals?.totalCalls  ?? 0,
      totalInput: totals?.totalInput  ?? 0,
      totalOutput: totals?.totalOutput ?? 0,
      byFeature,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to read today's usage" });
  }
});

// ── GET /api/admin/ai/diagnostics — runtime health snapshot ──────────────────
router.get("/ai/diagnostics", async (_req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0]!;

    // Circuit state
    const circuit = await getCircuitState();

    // Today's quota counters (global scope)
    const [quota] = await db
      .select({ calls: aiDailyQuotaTable.calls, tokens: aiDailyQuotaTable.tokens })
      .from(aiDailyQuotaTable)
      .where(and(eq(aiDailyQuotaTable.date, today), eq(aiDailyQuotaTable.scope, "global")));

    // Last provider error (most recent failed log row with an error_code)
    const [lastError] = await db
      .select({
        errorCode:   aiUsageLogTable.errorCode,
        completedAt: aiUsageLogTable.completedAt,
      })
      .from(aiUsageLogTable)
      .where(and(
        eq(aiUsageLogTable.status, "failed"),
        sql`${aiUsageLogTable.errorCode} IS NOT NULL`,
      ))
      .orderBy(desc(aiUsageLogTable.completedAt))
      .limit(1);

    // Last completed crawl run
    const [lastCrawl] = await db
      .select({
        aiModel:     crawlerRunsTable.aiModel,
        aiCallCount: crawlerRunsTable.aiCallCount,
        completedAt: crawlerRunsTable.completedAt,
      })
      .from(crawlerRunsTable)
      .where(eq(crawlerRunsTable.status, "success"))
      .orderBy(desc(crawlerRunsTable.completedAt))
      .limit(1);

    // Commit SHA — from env first, then git
    let commitSha: string | null = process.env.COMMIT_SHA ?? null;
    if (!commitSha) {
      try {
        commitSha = execSync("git rev-parse --short HEAD", { timeout: 2_000 }).toString().trim();
      } catch {
        commitSha = null;
      }
    }

    res.json({
      commitSha,
      aiEnabled:               !circuit.open,
      circuitStatus:           circuit.open ? "open" : "closed",
      circuitOpenedAt:         circuit.openedAt,
      circuitResetAt:          circuit.resetAt,
      todayCalls:              quota?.calls  ?? 0,
      todayTokens:             quota?.tokens ?? 0,
      configuredDailyCallLimit:  Number(process.env.AI_DAILY_CALL_LIMIT  ?? 200),
      configuredDailyTokenLimit: Number(process.env.AI_DAILY_TOKEN_LIMIT ?? 500_000),
      lastProviderErrorCode:   lastError?.errorCode  ?? null,
      lastProviderErrorAt:     lastError?.completedAt ?? null,
      lastCrawlScoringEngine:  lastCrawl ? (lastCrawl.aiModel ? "ai" : "keyword") : null,
      lastCrawlAiCallCount:    lastCrawl?.aiCallCount ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Failed to read diagnostics" });
  }
});

export default router;
