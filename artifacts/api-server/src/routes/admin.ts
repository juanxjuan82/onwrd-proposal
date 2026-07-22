import { Router, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { aiUsageLogTable, aiCircuitTable } from "@workspace/db";
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

export default router;
