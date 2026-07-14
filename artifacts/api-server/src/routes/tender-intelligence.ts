import { Router } from "express";
import { db } from "@workspace/db";
import {
  tenderSourcesTable,
  discoveredTendersTable,
  crawlerRunsTable,
  tenderSearchProfilesTable,
  tenderDigestSettingsTable,
} from "@workspace/db";
import { eq, desc, and, gte } from "drizzle-orm";
import { runCrawler, rescoreWithKeywords } from "../crawlers/index.js";

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

// ── Re-score existing items with keyword fallback ──────────────────────────
router.post("/tender-intelligence/rescore", async (req, res) => {
  try {
    const count = await rescoreWithKeywords();
    res.json({ message: `Re-scored ${count} items using keyword engine`, count });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Manual crawl trigger ───────────────────────────────────────────────────
router.post("/tender-intelligence/crawl", async (req, res) => {
  const sourceId = req.body?.sourceId ? Number(req.body.sourceId) : undefined;
  res.json({ message: "Crawl started in background" });
  void (async () => {
    try {
      await runCrawler(sourceId);
    } catch (err) {
      console.error("[manual-crawl] failed:", err);
    }
  })();
});

// ── Crawler run history ────────────────────────────────────────────────────
router.get("/crawler-runs", async (req, res) => {
  const runs = await db
    .select()
    .from(crawlerRunsTable)
    .orderBy(desc(crawlerRunsTable.startedAt))
    .limit(50);
  res.json(runs);
});

// ── Discovered Tenders ─────────────────────────────────────────────────────
router.get("/discovered-tenders", async (req, res) => {
  const status = req.query.status as string | undefined;
  const minScore = req.query.minScore ? Number(req.query.minScore) : undefined;

  let query = db.select().from(discoveredTendersTable);

  const conditions = [];
  if (status) conditions.push(eq(discoveredTendersTable.status, status));
  if (minScore !== undefined) conditions.push(gte(discoveredTendersTable.fitScore, minScore));

  const results = await (conditions.length > 0
    ? query.where(conditions.length === 1 ? conditions[0] : and(...conditions))
    : query)
    .orderBy(desc(discoveredTendersTable.fitScore), desc(discoveredTendersTable.createdAt))
    .limit(100);

  res.json(results);
});

router.get("/discovered-tenders/:id", async (req, res) => {
  const [item] = await db
    .select()
    .from(discoveredTendersTable)
    .where(eq(discoveredTendersTable.id, Number(req.params.id)));
  if (!item) { res.status(404).json({ error: "Not found" }); return; }
  res.json(item);
});

router.patch("/discovered-tenders/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body as { status?: string };
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (status) updates.status = status;
  const [updated] = await db
    .update(discoveredTendersTable)
    .set(updates)
    .where(eq(discoveredTendersTable.id, id))
    .returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(updated);
});

// ── Search Profiles ────────────────────────────────────────────────────────
router.get("/tender-search-profiles", async (req, res) => {
  const profiles = await db.select().from(tenderSearchProfilesTable).orderBy(tenderSearchProfilesTable.name);
  res.json(profiles);
});

router.post("/tender-search-profiles", async (req, res) => {
  const { name, description, keywords, excludedKeywords } = req.body as {
    name: string; description?: string; keywords?: string[]; excludedKeywords?: string[];
  };
  if (!name) { res.status(400).json({ error: "name required" }); return; }
  const [created] = await db.insert(tenderSearchProfilesTable).values({
    name,
    description: description ?? "",
    keywords: JSON.stringify(keywords ?? []),
    excludedKeywords: JSON.stringify(excludedKeywords ?? []),
  }).returning();
  res.status(201).json(created);
});

router.patch("/tender-search-profiles/:id", async (req, res) => {
  const id = Number(req.params.id);
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  const b = req.body as Record<string, unknown>;
  if (b.name) updates.name = b.name;
  if (b.description !== undefined) updates.description = b.description;
  if (Array.isArray(b.keywords)) updates.keywords = JSON.stringify(b.keywords);
  if (Array.isArray(b.excludedKeywords)) updates.excludedKeywords = JSON.stringify(b.excludedKeywords);
  if (b.active !== undefined) updates.active = b.active;
  const [updated] = await db
    .update(tenderSearchProfilesTable)
    .set(updates)
    .where(eq(tenderSearchProfilesTable.id, id))
    .returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(updated);
});

router.delete("/tender-search-profiles/:id", async (req, res) => {
  await db.delete(tenderSearchProfilesTable).where(eq(tenderSearchProfilesTable.id, Number(req.params.id)));
  res.status(204).end();
});

// ── Digest Settings ────────────────────────────────────────────────────────
async function getOrCreateDigestSettings() {
  const [existing] = await db.select().from(tenderDigestSettingsTable).limit(1);
  if (existing) return existing;
  const [created] = await db.insert(tenderDigestSettingsTable).values({
    emails: JSON.stringify(["j.aymes@onwrdadvisors.com"]),
    enabled: true,
  }).returning();
  return created;
}

router.get("/tender-digest-settings", async (_req, res) => {
  const settings = await getOrCreateDigestSettings();
  res.json({ ...settings, emails: JSON.parse(settings.emails) });
});

router.post("/tender-digest-settings/test", async (req, res) => {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    res.status(400).json({ error: "RESEND_API_KEY secret is not set. Add it in the Replit Secrets panel." });
    return;
  }
  const settings = await getOrCreateDigestSettings();
  const emails: string[] = JSON.parse(settings.emails);
  if (emails.length === 0) {
    res.status(400).json({ error: "No recipients configured. Add at least one email address first." });
    return;
  }
  try {
    const { Resend } = await import("resend");
    const resend = new Resend(apiKey);
    const fromAddress = process.env.RESEND_FROM ?? "ONWRD Tender Desk <onboarding@resend.dev>";
    const html = `
<div style="font-family:sans-serif;max-width:700px;margin:0 auto;color:#fff;background:#0a0a0a;padding:32px">
  <img src="https://onwrdadvisors.com/wp-content/uploads/2024/01/onwrd-logo-white.png" style="height:40px;margin-bottom:24px" alt="ONWRD"/>
  <h2 style="color:#fff;margin-bottom:4px">Tender Intelligence Digest — Test Email</h2>
  <p style="color:#888;margin-top:0">${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</p>
  <p>This is a test email confirming your digest is configured correctly. 🎉</p>
  <p>When live tenders are discovered each morning, you'll see a summary here with <strong style="color:#4ade80">🔥 Pursue</strong> and <strong style="color:#facc15">⚡ Consider</strong> opportunities.</p>
  <p style="margin-top:32px;color:#555;font-size:12px">ONWRD Proposal Desk — automated tender intelligence</p>
</div>`;
    const { error } = await resend.emails.send({
      from: fromAddress,
      to: emails,
      subject: `[ONWRD] Digest test — ${new Date().toLocaleDateString()}`,
      html,
    });
    if (error) {
      res.status(500).json({ error: error.message ?? "Resend returned an error" });
      return;
    }
    res.json({ message: `Test email sent to ${emails.join(", ")}` });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.put("/tender-digest-settings", async (req, res) => {
  const { emails, enabled } = req.body as { emails?: string[]; enabled?: boolean };
  const settings = await getOrCreateDigestSettings();
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (Array.isArray(emails)) updates.emails = JSON.stringify(emails.map((e: string) => e.trim()).filter(Boolean));
  if (enabled !== undefined) updates.enabled = enabled;
  const [updated] = await db
    .update(tenderDigestSettingsTable)
    .set(updates)
    .where(eq(tenderDigestSettingsTable.id, settings.id))
    .returning();
  res.json({ ...updated, emails: JSON.parse(updated.emails) });
});

router.post("/tender-intelligence/notify-billing", async (req, res) => {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    res.status(400).json({ error: "RESEND_API_KEY not set." });
    return;
  }
  try {
    const { Resend } = await import("resend");
    const resend = new Resend(apiKey);
    const fromAddress = process.env.RESEND_FROM ?? "ONWRD Tender Desk <onboarding@resend.dev>";
    const to = req.body?.to ?? "r.dean@onwrdadvisors.com";
    const html = `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#fff;background:#0a0a0a;padding:32px;border-radius:8px">
  <img src="https://onwrdadvisors.com/wp-content/uploads/2024/01/onwrd-logo-white.png" style="height:36px;margin-bottom:24px" alt="ONWRD"/>
  <h2 style="color:#fff;margin-bottom:4px">Action Required: OpenAI Billing</h2>
  <p style="color:#888;margin-top:0;font-size:13px">${new Date().toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" })}</p>
  <div style="background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:16px;margin:20px 0">
    <p style="color:#f87171;font-weight:600;margin:0 0 8px">⚠️ AI features are currently offline</p>
    <p style="color:#aaa;margin:0;font-size:14px">The OpenAI API key on the ONWRD Proposal Desk has exceeded its quota. Proposal generation and AI scoring are unavailable until the account is topped up.</p>
  </div>
  <p style="color:#ccc;font-size:14px"><strong style="color:#fff">To fix:</strong> Log in to <a href="https://platform.openai.com/account/billing" style="color:#60a5fa">platform.openai.com/account/billing</a> and add credit to the account.</p>
  <p style="color:#ccc;font-size:14px">Tender crawling and keyword scoring are still running normally. Only AI-powered features (proposal generation, AI scoring) are affected.</p>
  <p style="margin-top:32px;color:#555;font-size:12px">Sent from ONWRD Proposal Desk — automated billing alert</p>
</div>`;
    const { error } = await resend.emails.send({
      from: fromAddress,
      to: Array.isArray(to) ? to : [to],
      subject: `[ONWRD] Action required: OpenAI billing quota exceeded`,
      html,
    });
    if (error) { res.status(500).json({ error: error.message }); return; }
    res.json({ message: `Billing alert sent to ${Array.isArray(to) ? to.join(", ") : to}` });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
