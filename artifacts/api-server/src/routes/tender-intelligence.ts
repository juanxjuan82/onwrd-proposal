import { Router } from "express";
import { db } from "@workspace/db";
import {
  tenderSourcesTable,
  discoveredTendersTable,
  crawlerRunsTable,
  tenderSearchProfilesTable,
} from "@workspace/db";
import { eq, desc, and, gte } from "drizzle-orm";
import { runCrawler } from "../crawlers/index.js";

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

// ── Manual crawl trigger ───────────────────────────────────────────────────
router.post("/tender-intelligence/crawl", async (req, res) => {
  const sourceId = req.body.sourceId ? Number(req.body.sourceId) : undefined;
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

export default router;
