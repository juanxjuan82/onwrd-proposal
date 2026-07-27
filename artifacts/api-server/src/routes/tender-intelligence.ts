import { Router } from "express";
import { db } from "@workspace/db";
import {
  tenderSourcesTable,
  discoveredTendersTable,
  crawlerRunsTable,
  crawlBatchesTable,
  tenderSearchProfilesTable,
  tenderDigestSettingsTable,
} from "@workspace/db";
import { eq, desc, and, gte, isNull, or, sql } from "drizzle-orm";
import { startCrawl, executeCrawlBatch, rescoreWithKeywords, backfillPromotions } from "../crawlers/index.js";
import { promoteDiscoveredTender } from "../lib/promote-discovered-tender.js";

const router = Router();

// ── Tender Sources ─────────────────────────────────────────────────────────
router.get("/tender-sources", async (req, res) => {
  const sources = await db.select().from(tenderSourcesTable).orderBy(tenderSourcesTable.name);
  res.json(sources);
});

router.post("/tender-sources", async (req, res) => {
  const { name, sourceType, url, adapterType } = req.body as {
    name: string; sourceType: string; url: string; adapterType: string;
  };
  if (!name || !url || !adapterType) {
    res.status(400).json({ error: "name, url, adapterType required" });
    return;
  }
  const [created] = await db.insert(tenderSourcesTable).values({
    name, sourceType: sourceType ?? "other", url, adapterType, active: true,
  }).returning();
  res.status(201).json(created);
});

router.patch("/tender-sources/:id", async (req, res) => {
  const id = Number(req.params.id);
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (req.body.active !== undefined) updates.active = req.body.active;
  if (req.body.name) updates.name = req.body.name;
  const [updated] = await db.update(tenderSourcesTable).set(updates).where(eq(tenderSourcesTable.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(updated);
});

router.delete("/tender-sources/:id", async (req, res) => {
  await db.delete(tenderSourcesTable).where(eq(tenderSourcesTable.id, Number(req.params.id)));
  res.status(204).end();
});

// ── Re-score existing items with keyword engine ────────────────────────────
router.post("/tender-intelligence/rescore", async (req, res) => {
  try {
    const count = await rescoreWithKeywords();
    res.json({ message: `Re-scored ${count} items using keyword engine`, count });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Backfill: evaluate ALL unpromoted non-expired discoveries ──────────────
router.post("/tender-intelligence/backfill-promotions", async (req, res) => {
  try {
    const result = await backfillPromotions();
    res.json({
      message: `Backfill complete: ${result.promoted} promoted, ${result.rejected} rejected (${result.evaluated} evaluated)`,
      ...result,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Manual crawl trigger ── returns 202 + exact batchId immediately ────────
// startCrawl() atomically acquires the lock, persists the batch row, and
// returns the exact batchId. If the lock is already held it returns null
// (mapped to 409). executeCrawlBatch() runs in the background.
router.post("/tender-intelligence/crawl", async (req, res) => {
  const sourceId = req.body?.sourceId ? Number(req.body.sourceId) : undefined;

  const batchId = await startCrawl(sourceId);
  if (!batchId) {
    res.status(409).json({ error: "A crawl is already in progress. Please wait for it to finish." });
    return;
  }

  // Fire-and-forget — the batch row already exists with status "running"
  void executeCrawlBatch(batchId, sourceId).then((result) => {
    console.log(
      `[manual-crawl] Done. batch=${result.batchId} inserted=${result.inserted} ` +
      `promoted=${result.promoted} failed-sources=${result.sourcesFailed}`,
    );
  }).catch((err) => {
    console.error("[manual-crawl] failed:", err instanceof Error ? err.message : String(err));
  });

  res.status(202).json({ message: "Crawl started in background", batchId });
});

// ── Poll crawl batch status ────────────────────────────────────────────────
router.get("/tender-intelligence/crawl-batches/:id", async (req, res) => {
  const rows = await db
    .select()
    .from(crawlBatchesTable)
    .where(eq(crawlBatchesTable.id, req.params.id))
    .limit(1);

  if (!rows[0]) {
    res.status(404).json({ error: "Batch not found" });
    return;
  }
  res.json(rows[0]);
});

// ── List recent crawl batches ──────────────────────────────────────────────
router.get("/tender-intelligence/crawl-batches", async (_req, res) => {
  const rows = await db
    .select()
    .from(crawlBatchesTable)
    .orderBy(desc(crawlBatchesTable.startedAt))
    .limit(20);
  res.json(rows);
});

// ── Crawler runs (per-source detail) ──────────────────────────────────────
router.get("/crawler-runs", async (_req, res) => {
  const runs = await db.select().from(crawlerRunsTable).orderBy(desc(crawlerRunsTable.startedAt)).limit(100);
  res.json(runs);
});

// ── Discovered tenders ─────────────────────────────────────────────────────
router.get("/tender-intelligence/discovered", async (req, res) => {
  const { status, recommendation, limit: limitStr, sourceId: sourceIdStr } = req.query as Record<string, string | undefined>;
  const limit = Math.min(Number(limitStr ?? 100), 200);

  const conditions = [];
  if (status)         conditions.push(eq(discoveredTendersTable.status, status));
  if (recommendation) conditions.push(eq(discoveredTendersTable.recommendation, recommendation));
  if (sourceIdStr)    conditions.push(eq(discoveredTendersTable.sourceId, Number(sourceIdStr)));

  const results = await (conditions.length > 0
    ? db.select().from(discoveredTendersTable).where(and(...conditions)).orderBy(desc(discoveredTendersTable.createdAt)).limit(limit)
    : db.select().from(discoveredTendersTable).orderBy(desc(discoveredTendersTable.createdAt)).limit(limit));

  res.json(results);
});

// ── Promote a discovered tender to canonical Opportunity ──────────────────
router.post("/tender-intelligence/discovered/:id/promote", async (req, res) => {
  const id = Number(req.params.id);
  const dest = req.body?.destination ?? "new";
  try {
    const result = await promoteDiscoveredTender(id, dest);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Tender search profiles ─────────────────────────────────────────────────
router.get("/tender-intelligence/search-profiles", async (_req, res) => {
  const profiles = await db.select().from(tenderSearchProfilesTable).orderBy(tenderSearchProfilesTable.name);
  res.json(profiles);
});

// ── Tender digest settings ─────────────────────────────────────────────────
router.get("/tender-intelligence/digest-settings", async (_req, res) => {
  const [settings] = await db.select().from(tenderDigestSettingsTable).limit(1);
  res.json(settings ?? { enabled: false, emails: "[]" });
});

router.post("/tender-intelligence/digest-settings", async (req, res) => {
  const { enabled, emails } = req.body as { enabled?: boolean; emails?: string[] };
  const [existing] = await db.select().from(tenderDigestSettingsTable).limit(1);
  if (existing) {
    const [updated] = await db.update(tenderDigestSettingsTable).set({
      ...(enabled !== undefined ? { enabled } : {}),
      ...(emails ? { emails: JSON.stringify(emails) } : {}),
      updatedAt: new Date(),
    }).where(eq(tenderDigestSettingsTable.id, existing.id)).returning();
    res.json(updated);
  } else {
    const [created] = await db.insert(tenderDigestSettingsTable).values({
      enabled: enabled ?? true,
      emails: JSON.stringify(emails ?? []),
    }).returning();
    res.json(created);
  }
});

// ── Admin: send quota alert email ─────────────────────────────────────────
router.post("/admin/send-quota-alert", async (req, res) => {
  const { to } = req.body as { to: string | string[] };
  if (!to) { res.status(400).json({ error: "to address required" }); return; }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { res.status(500).json({ error: "RESEND_API_KEY not configured" }); return; }

  try {
    const fromAddress = process.env.RESEND_FROM ?? "ONWRD Proposal Desk <onboarding@resend.dev>";
    const html = `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#fff;background:#0a0a0a;padding:32px">
  <img src="https://onwrdadvisors.com/wp-content/uploads/2024/01/onwrd-logo-white.png" style="height:36px;margin-bottom:24px" alt="ONWRD"/>
  <h2 style="color:#fff;margin-bottom:4px">Action Required: AI Features Offline</h2>
  <p style="color:#888;margin-top:0;font-size:13px">${new Date().toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" })}</p>
  <div style="background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:16px;margin:20px 0">
    <p style="color:#f87171;font-weight:600;margin:0 0 8px">⚠️ AI features are currently offline</p>
    <p style="color:#aaa;margin:0;font-size:14px">The OpenAI API key has exceeded its billing quota. Proposal generation is unavailable. Tender crawling and keyword scoring are still running normally.</p>
  </div>
  <p style="color:#fff;font-size:15px;font-weight:600;margin-bottom:12px">To restore AI features:</p>
  <div style="background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:16px">
    <p style="color:#facc15;font-weight:700;margin:0 0 6px">Top up OpenAI billing</p>
    <ol style="color:#ccc;font-size:14px;margin:0;padding-left:18px;line-height:1.8">
      <li>Go to <a href="https://platform.openai.com/account/billing" style="color:#60a5fa">platform.openai.com/account/billing</a></li>
      <li>Add a payment method and purchase credit (minimum $10)</li>
      <li>The system resumes automatically</li>
    </ol>
  </div>
  <p style="margin-top:16px;color:#555;font-size:12px">Sent from ONWRD Proposal Desk — automated billing alert</p>
</div>`;
    const { Resend: ResendClient } = await import("resend");
    const resend = new ResendClient(apiKey);
    const { error } = await resend.emails.send({
      from: fromAddress,
      to: Array.isArray(to) ? to : [to],
      subject: `[ONWRD] Action required: AI features offline`,
      html,
    });
    if (error) { res.status(500).json({ error: error.message }); return; }
    res.json({ message: `Billing alert sent to ${Array.isArray(to) ? to.join(", ") : to}` });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
