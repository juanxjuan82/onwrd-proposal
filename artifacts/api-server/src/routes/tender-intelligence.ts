import { Router } from "express";
import { db } from "@workspace/db";
import {
  tenderSourcesTable,
  discoveredTendersTable,
  crawlerRunsTable,
  tenderSearchProfilesTable,
  tenderDigestSettingsTable,
} from "@workspace/db";
import { eq, desc, and, gte, inArray, isNotNull, count, sql } from "drizzle-orm";
import {
  runCrawler,
  rescoreWithKeywords,
  backfillPromotions,
  isCrawlRunning,
  SOURCE_ADAPTER_CATALOG,
  getSourceAdapterDefinition,
  getCrawlBlockReason,
  requiresControlledPilot,
  validateSourceConfiguration,
} from "../crawlers/index.js";
import { promoteDiscoveredTender } from "../lib/promote-discovered-tender.js";
import {
  DEFAULT_DIGEST_RECIPIENTS,
  parseDigestRecipients,
  shouldUpgradeLegacyRecipients,
  validateDigestRecipients,
} from "../lib/digest-settings.js";
import { filterActionableDigestTenders } from "../lib/digest-eligibility.js";
import { evaluateCrawlerEligibility } from "../lib/crawler-eligibility.js";
import { deriveSourceHealth } from "../lib/source-health.js";

const router = Router();

// ── Tender Sources ─────────────────────────────────────────────────────────
router.get("/tender-sources", async (req, res) => {
  const sources = await db.select().from(tenderSourcesTable).orderBy(tenderSourcesTable.name);
  const runs = await db.select().from(crawlerRunsTable).orderBy(desc(crawlerRunsTable.startedAt));
  const runsBySource = new Map<number, typeof runs>();
  for (const run of runs) {
    const sourceRuns = runsBySource.get(run.sourceId) ?? [];
    if (sourceRuns.length < 10) sourceRuns.push(run);
    runsBySource.set(run.sourceId, sourceRuns);
  }
  res.json(sources.map((source) => {
    const sourceRuns = runsBySource.get(source.id) ?? [];
    const definition = getSourceAdapterDefinition(source.adapterType);
    const health = deriveSourceHealth(source, sourceRuns);
    return {
      ...source,
      ...health,
      adapterSupported: Boolean(definition),
      activationBlocked: definition?.blockedReason ?? null,
    };
  }));
});

router.post("/tender-sources", async (req, res) => {
  const { name, sourceType, url, adapterType, browserEnabled, approvedDomains } = req.body as {
    name: string;
    sourceType: string;
    url: string;
    adapterType: string;
    browserEnabled?: boolean;
    approvedDomains?: string[];
  };
  if (!name || !url || !adapterType) {
    res.status(400).json({ error: "name, url, adapterType required" });
    return;
  }
  const validated = validateSourceConfiguration({ adapterType, url, approvedDomains });
  if ("error" in validated) {
    res.status(400).json({ error: validated.error });
    return;
  }
  const [created] = await db.insert(tenderSourcesTable).values({
    name,
    sourceType: sourceType ?? validated.definition.sourceType,
    url,
    adapterType,
    // New sources must prove they work before they become operational.
    active: false,
    browserEnabled: browserEnabled === true && validated.definition.supportsBrowser,
    approvedDomains: validated.domains,
  }).returning();
  res.status(201).json({ ...created, message: "Source saved inactive. Run a test crawl with usable records before activating it." });
});

router.patch("/tender-sources/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [current] = await db.select().from(tenderSourcesTable).where(eq(tenderSourcesTable.id, id));
  if (!current) { res.status(404).json({ error: "Not found" }); return; }
  const body = req.body as Record<string, unknown>;
  const adapterType = typeof body.adapterType === "string" ? body.adapterType : current.adapterType;
  const url = typeof body.url === "string" ? body.url : current.url;
  const approvedDomains = body.approvedDomains !== undefined
    ? body.approvedDomains
    : body.url !== undefined || body.adapterType !== undefined
      ? undefined
      : current.approvedDomains;
  const validated = validateSourceConfiguration({ adapterType, url, approvedDomains });
  if ("error" in validated) {
    res.status(400).json({ error: validated.error });
    return;
  }
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  const nextBrowserEnabled = body.browserEnabled !== undefined
    ? body.browserEnabled === true && validated.definition.supportsBrowser
    : current.browserEnabled;
  const domainsChanged = body.approvedDomains !== undefined || body.url !== undefined || body.adapterType !== undefined
    ? JSON.stringify(validated.domains) !== JSON.stringify(current.approvedDomains ?? [])
    : false;
  const configChanged =
    adapterType !== current.adapterType ||
    url !== current.url ||
    domainsChanged ||
    nextBrowserEnabled !== current.browserEnabled;
  const currentBlockReason = getCrawlBlockReason(current.adapterType);
  const requestedBlockReason = getCrawlBlockReason(adapterType);
  if (configChanged && body.active === true) {
    res.status(422).json({
      error: "Save configuration changes while inactive, run a successful test crawl with usable records, then activate the source.",
      code: "configuration_requires_retest",
    });
    return;
  }
  if (configChanged || validated.definition.blockedReason) {
    updates.active = false;
  }
  if (configChanged) {
    updates.configurationVersion = sql`${tenderSourcesTable.configurationVersion} + 1`;
  }
  if (body.active !== undefined) {
    if (typeof body.active !== "boolean") {
      res.status(400).json({ error: "active must be a boolean" });
      return;
    }
    if (body.active && (requestedBlockReason || (adapterType === current.adapterType && currentBlockReason))) {
      res.status(422).json({
        error: requestedBlockReason ?? currentBlockReason,
        code: "activation_blocked",
      });
      return;
    }
    if (body.active && !current.active) {
      const [proof] = await db.select({ id: crawlerRunsTable.id })
        .from(crawlerRunsTable)
        .where(and(
          eq(crawlerRunsTable.sourceId, id),
          eq(crawlerRunsTable.sourceConfigurationVersion, current.configurationVersion),
          eq(crawlerRunsTable.status, "success"),
          gte(crawlerRunsTable.itemsNew, 1),
        ))
        .orderBy(desc(crawlerRunsTable.completedAt))
        .limit(1);
      if (!proof) {
        if (requiresControlledPilot(adapterType)) {
          res.status(422).json({
            error: "Activation requires a successful, versioned, source-specific pilot with at least one usable new record. Run the pilot while inactive for the current configuration version, then try again.",
            code: "activation_requires_versioned_pilot",
          });
          return;
        }
        res.status(422).json({
          error: "Activation requires a successful test crawl that persists at least one usable new record. Run this source while inactive, then try again.",
          code: "activation_requires_test",
        });
        return;
      }
    }
    updates.active = body.active;
  }
  if (typeof body.name === "string" && body.name.trim()) updates.name = body.name.trim();
  if (typeof body.sourceType === "string" && body.sourceType.trim()) updates.sourceType = body.sourceType.trim();
  if (body.adapterType !== undefined) updates.adapterType = adapterType;
  if (body.url !== undefined) updates.url = url;
  if (body.browserEnabled !== undefined) {
    if (typeof body.browserEnabled !== "boolean") {
      res.status(400).json({ error: "browserEnabled must be a boolean" });
      return;
    }
    updates.browserEnabled = nextBrowserEnabled;
  }
  if (body.approvedDomains !== undefined || body.url !== undefined) updates.approvedDomains = validated.domains;
  const [updated] = await db
    .update(tenderSourcesTable)
    .set(updates)
    .where(and(
      eq(tenderSourcesTable.id, id),
      eq(tenderSourcesTable.configurationVersion, current.configurationVersion),
    ))
    .returning();
  if (!updated) {
    res.status(409).json({
      error: "This source changed while your update was being saved. Review the latest configuration and try again.",
      code: "source_configuration_conflict",
    });
    return;
  }
  res.json(updated);
});

router.delete("/tender-sources/:id", async (req, res) => {
  const id = Number(req.params.id);
  const [source] = await db.select().from(tenderSourcesTable).where(eq(tenderSourcesTable.id, id));
  if (!source) { res.status(404).json({ error: "Not found" }); return; }
  if (req.body?.confirm !== source.name) {
    res.status(400).json({ error: `Permanent removal requires confirm to match "${source.name}".` });
    return;
  }
  const [runCount] = await db.select({ value: count() }).from(crawlerRunsTable).where(eq(crawlerRunsTable.sourceId, id));
  const [tenderCount] = await db.select({ value: count() }).from(discoveredTendersTable).where(eq(discoveredTendersTable.sourceId, id));
  if (Number(runCount?.value ?? 0) > 0 || Number(tenderCount?.value ?? 0) > 0) {
    res.status(409).json({
      error: "This source has crawl history and cannot be permanently removed. Deactivate it instead to preserve historical records.",
      runs: Number(runCount?.value ?? 0),
      records: Number(tenderCount?.value ?? 0),
    });
    return;
  }
  await db.delete(tenderSourcesTable).where(eq(tenderSourcesTable.id, id));
  res.status(204).end();
});

router.get("/tender-source-adapters", (_req, res) => {
  res.json(SOURCE_ADAPTER_CATALOG);
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

// ── Backfill: promote existing eligible discoveries ────────────────────────
// Finds all discovered_tenders with CONSIDER/PURSUE recommendation that were
// never promoted (opportunityId IS NULL) and promotes the eligible ones.
// Safe to run multiple times — idempotent.
router.post("/tender-intelligence/backfill-promotions", async (req, res) => {
  try {
    const result = await backfillPromotions();
    res.json({
      message: `Backfill complete: ${result.promoted} promoted, ${result.skipped} skipped (${result.evaluated} evaluated)`,
      ...result,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Manual crawl trigger ───────────────────────────────────────────────────
router.post("/tender-intelligence/crawl", async (req, res) => {
  if (await isCrawlRunning()) {
    res.status(409).json({ error: "A crawl is already in progress. Please wait for it to finish." });
    return;
  }

  const sourceId = req.body?.sourceId ? Number(req.body.sourceId) : undefined;
  if (sourceId) {
    const [source] = await db
      .select({ adapterType: tenderSourcesTable.adapterType })
      .from(tenderSourcesTable)
      .where(eq(tenderSourcesTable.id, sourceId));
    if (!source) {
      res.status(404).json({ error: "Source not found." });
      return;
    }
    const definition = getSourceAdapterDefinition(source.adapterType);
    if (!definition) {
      res.status(422).json({ error: "This source uses an unsupported crawler adapter." });
      return;
    }
    if (definition.blockedReason) {
      res.status(422).json({ error: definition.blockedReason, code: "source_blocked" });
      return;
    }
  }
  res.json({ message: "Crawl started in background" });

  void runCrawler(sourceId).then((result) => {
    console.log(
      `[manual-crawl] Done. ${result.newItems} new. ` +
      `AI calls: ${result.aiCallCount}, fallbacks: ${result.aiFallbackCount}` +
      `${result.quotaErrorHit ? " ⚠ quota error — circuit opened" : ""}`
    );
  }).catch((err) => {
    console.error("[manual-crawl] failed:", err instanceof Error ? err.message : String(err));
  });
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
router.get("/discovered-tenders/overview", async (_req, res) => {
  const [lastCrawl] = await db
    .select({
      id: crawlerRunsTable.id,
      startedAt: crawlerRunsTable.startedAt,
      completedAt: crawlerRunsTable.completedAt,
      status: crawlerRunsTable.status,
      itemsFound: crawlerRunsTable.itemsFound,
      itemsNew: crawlerRunsTable.itemsNew,
      errorMessage: crawlerRunsTable.errorMessage,
    })
    .from(crawlerRunsTable)
    .orderBy(desc(crawlerRunsTable.startedAt))
    .limit(1);

  const [latestTender] = await db
    .select({ createdAt: discoveredTendersTable.createdAt })
    .from(discoveredTendersTable)
    .orderBy(desc(discoveredTendersTable.createdAt))
    .limit(1);

  res.json({
    lastCrawl: lastCrawl ?? null,
    latestTenderAddedAt: latestTender?.createdAt ?? null,
  });
});

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

// ── Promote discovered tender to canonical Opportunity ─────────────────────
// Idempotent: if opportunityId is already set, returns it without a second insert.
// Concurrent callers are serialised by SELECT FOR UPDATE inside the service.
router.post("/discovered-tenders/:id/promote", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  try {
    const [discovery] = await db
      .select({
        title: discoveredTendersTable.title,
        description: discoveredTendersTable.description,
        recommendation: discoveredTendersTable.recommendation,
        deadline: discoveredTendersTable.deadline,
      })
      .from(discoveredTendersTable)
      .where(eq(discoveredTendersTable.id, id));
    if (!discovery) {
      res.status(404).json({ error: "Discovered tender not found" });
      return;
    }
    const eligibility = evaluateCrawlerEligibility({
      title: discovery.title,
      description: discovery.description,
      recommendation: discovery.recommendation ?? "SKIP",
      deadline: discovery.deadline,
    });
    if (!eligibility.eligible) {
      res.status(422).json({
        error: "This discovery is not eligible for an actionable opportunity",
        code: "ineligible_discovery",
        reasons: eligibility.rejectionReasons,
      });
      return;
    }
    const result = await promoteDiscoveredTender(id);
    res.json(result);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "NOT_FOUND") {
      res.status(404).json({ error: "Discovered tender not found" });
      return;
    }
    res.status(500).json({ error: "Failed to promote discovered tender" });
  }
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
  if (existing) {
    const emails = parseDigestRecipients(existing.emails);
    if (shouldUpgradeLegacyRecipients(emails)) {
      const [updated] = await db
        .update(tenderDigestSettingsTable)
        .set({ emails: JSON.stringify(DEFAULT_DIGEST_RECIPIENTS), updatedAt: new Date() })
        .where(eq(tenderDigestSettingsTable.id, existing.id))
        .returning();
      return updated;
    }
    return existing;
  }
  const [created] = await db.insert(tenderDigestSettingsTable).values({
    emails: JSON.stringify(DEFAULT_DIGEST_RECIPIENTS),
    enabled: true,
  }).returning();
  return created;
}

router.get("/tender-digest-settings", async (_req, res) => {
  const settings = await getOrCreateDigestSettings();
  res.json({ ...settings, emails: parseDigestRecipients(settings.emails) });
});

router.post("/tender-digest-settings/test", async (req, res) => {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    res.status(400).json({ error: "RESEND_API_KEY secret is not set. Add it in the Replit Secrets panel." });
    return;
  }
  const settings = await getOrCreateDigestSettings();
  const emails = parseDigestRecipients(settings.emails);
  if (emails.length === 0) {
    res.status(400).json({ error: "No recipients configured. Add at least one email address first." });
    return;
  }
  try {
    // Pull all PURSUE + CONSIDER tenders for sample digest
    const allTenders = await db
      .select()
      .from(discoveredTendersTable)
      .where(and(
        eq(discoveredTendersTable.status, "new"),
        isNotNull(discoveredTendersTable.opportunityId),
        inArray(discoveredTendersTable.recommendation, ["PURSUE", "CONSIDER"]),
      ))
      .orderBy(desc(discoveredTendersTable.fitScore));
    const actionableTenders = filterActionableDigestTenders(allTenders);

    const pursue = actionableTenders.filter((t) => t.recommendation === "PURSUE");
    const consider = actionableTenders.filter((t) => t.recommendation === "CONSIDER");

    // Sort: Bahamas first, then by fitScore desc
    const sortBahamasFirst = (list: typeof allTenders) =>
      [...list].sort((a, b) => {
        const aBs = (a.country ?? "").toLowerCase().includes("bahamas") ? 1 : 0;
        const bBs = (b.country ?? "").toLowerCase().includes("bahamas") ? 1 : 0;
        if (bBs !== aBs) return bBs - aBs;
        return (b.fitScore ?? 0) - (a.fitScore ?? 0);
      });

    const pursueSorted = sortBahamasFirst(pursue);
    const considerSorted = sortBahamasFirst(consider);

    const isBahamasEntry = (t: (typeof allTenders)[number]) =>
      (t.country ?? "").toLowerCase().includes("bahamas");
    const bahamasCount = [...pursue, ...consider].filter(isBahamasEntry).length;
    const bahamasTracked = actionableTenders.filter(isBahamasEntry).length;

    const { Resend } = await import("resend");
    const resend = new Resend(apiKey);
    const fromAddress = process.env.RESEND_FROM ?? "ONWRD Tender Desk <onboarding@resend.dev>";

    const flagFor = (country: string | null) => {
      const c = (country ?? "").toLowerCase();
      if (c.includes("bahamas")) return "🇧🇸 ";
      if (c.includes("barbados")) return "🇧🇧 ";
      if (c.includes("jamaica")) return "🇯🇲 ";
      if (c.includes("trinidad")) return "🇹🇹 ";
      if (c.includes("cayman")) return "🇰🇾 ";
      if (c.includes("antigua")) return "🇦🇬 ";
      if (c.includes("belize")) return "🇧🇿 ";
      if (c.includes("guyana")) return "🇬🇾 ";
      if (c.includes("haiti")) return "🇭🇹 ";
      if (c.includes("turks")) return "🇹🇨 ";
      return "🌍 ";
    };

    const rows = (list: typeof allTenders) =>
      list
        .map((t) => {
          const isBahamas = (t.country ?? "").toLowerCase().includes("bahamas");
          const rowBg = isBahamas ? "background:#0f1a10;" : "";
          const titleColor = isBahamas ? "#4ade80" : "#ffffff";
          const deadlineStr = t.deadline ? new Date(t.deadline).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "–";
          const daysLeft = t.deadline
            ? Math.ceil((new Date(t.deadline).getTime() - Date.now()) / 86400000)
            : null;
          const urgency =
            daysLeft !== null && daysLeft <= 14 && daysLeft >= 0
              ? `<span style="color:#f87171;font-size:11px"> ⚠ ${daysLeft}d left</span>`
              : "";
          return `<tr style="${rowBg}">
              <td style="padding:10px 8px;border-bottom:1px solid #1f1f1f">
                ${flagFor(t.country)}<strong style="color:${titleColor}">${t.title}</strong>
                ${isBahamas ? '<span style="background:#14532d;color:#4ade80;font-size:10px;padding:1px 6px;border-radius:999px;margin-left:6px">Bahamas</span>' : ""}
              </td>
              <td style="padding:10px 8px;border-bottom:1px solid #1f1f1f;color:#aaa;font-size:13px">${t.organization ?? "–"}</td>
              <td style="padding:10px 8px;border-bottom:1px solid #1f1f1f;text-align:center">
                <span style="background:#1e3a1e;color:#4ade80;padding:2px 8px;border-radius:999px;font-size:13px;font-weight:600">${t.fitScore ?? "–"}</span>
              </td>
              <td style="padding:10px 8px;border-bottom:1px solid #1f1f1f;color:#aaa;font-size:13px">${deadlineStr}${urgency}</td>
            </tr>`;
        })
        .join("");

    const today = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const html = `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:700px;margin:0 auto;color:#fff;background:#0a0a0a;padding:0">
  <!-- Header -->
  <div style="background:#0d0d0d;border-bottom:1px solid #1f1f1f;padding:24px 32px;display:flex;align-items:center">
    <img src="https://onwrdadvisors.com/wp-content/uploads/2024/01/onwrd-logo-white.png" style="height:36px" alt="ONWRD"/>
  </div>

  <!-- Body -->
  <div style="padding:32px">
    <h2 style="color:#fff;margin:0 0 4px">Tender Intelligence Digest</h2>
    <p style="color:#666;margin:0 0 24px;font-size:14px">${today} &nbsp;·&nbsp; Sample / Test Send</p>

    <!-- Summary pill row -->
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:28px">
      <div style="background:#1e3a1e;border:1px solid #166534;border-radius:10px;padding:12px 20px;min-width:110px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:#4ade80">${pursue.length}</div>
        <div style="font-size:12px;color:#86efac;margin-top:2px">Pursue</div>
      </div>
      <div style="background:#1c1a0a;border:1px solid #713f12;border-radius:10px;padding:12px 20px;min-width:110px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:#facc15">${consider.length}</div>
        <div style="font-size:12px;color:#fde047;margin-top:2px">Consider</div>
      </div>
      <div style="background:#0f1a10;border:1px solid #166534;border-radius:10px;padding:12px 20px;min-width:110px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:#34d399">🇧🇸 ${bahamasCount}</div>
        <div style="font-size:12px;color:#6ee7b7;margin-top:2px">Bahamas to action</div>
        ${bahamasTracked > bahamasCount ? `<div style="font-size:11px;color:#4b7a5a;margin-top:2px">${bahamasTracked} tracked total</div>` : ""}
      </div>
    </div>

    ${pursueSorted.length > 0 ? `
    <h3 style="color:#4ade80;margin:0 0 12px;font-size:16px">🔥 Pursue (${pursueSorted.length})</h3>
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:32px">
      <thead><tr style="color:#555;font-size:12px;text-transform:uppercase;letter-spacing:.05em">
        <th style="text-align:left;padding:8px">Opportunity</th>
        <th style="text-align:left;padding:8px">Organisation</th>
        <th style="text-align:center;padding:8px">Score</th>
        <th style="text-align:left;padding:8px">Deadline</th>
      </tr></thead>
      <tbody>${rows(pursueSorted)}</tbody>
    </table>` : `<p style="color:#555;font-size:14px">No PURSUE opportunities in current database — they'll appear here when crawlers surface marketing/comms RFPs.</p>`}

    ${considerSorted.length > 0 ? `
    <h3 style="color:#facc15;margin:0 0 12px;font-size:16px">⚡ Consider (${considerSorted.length})</h3>
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:32px">
      <thead><tr style="color:#555;font-size:12px;text-transform:uppercase;letter-spacing:.05em">
        <th style="text-align:left;padding:8px">Opportunity</th>
        <th style="text-align:left;padding:8px">Organisation</th>
        <th style="text-align:center;padding:8px">Score</th>
        <th style="text-align:left;padding:8px">Deadline</th>
      </tr></thead>
      <tbody>${rows(considerSorted)}</tbody>
    </table>` : ""}

    <div style="background:#111;border:1px solid #1f1f1f;border-radius:10px;padding:16px 20px;font-size:13px;color:#666">
      <strong style="color:#888">About this digest</strong><br/>
      Bahamas opportunities are highlighted and sorted to the top. The daily digest runs at 06:00 and scans sources including Bahamas Gov, World Bank, IDB, CDB, and Caribbean Tourism Organisation. ${bahamasTracked} Bahamas tenders currently tracked — ${bahamasCount > 0 ? `${bahamasCount} actionable` : "none actionable yet (current postings are infrastructure/IT)"}.
    </div>
  </div>

  <!-- Footer -->
  <div style="border-top:1px solid #1a1a1a;padding:20px 32px;font-size:11px;color:#444">
    ONWRD Proposal Desk — automated tender intelligence &nbsp;·&nbsp; Manage preferences at your Proposal Desk dashboard
  </div>
</div>`;

    const { error } = await resend.emails.send({
      from: fromAddress,
      to: emails,
      subject: `[ONWRD] ${pursue.length} to pursue, ${consider.length} to consider — Tender Digest ${new Date().toLocaleDateString()}`,
      html,
    });
    if (error) {
      res.status(500).json({ error: error.message ?? "Resend returned an error" });
      return;
    }
    res.json({
      message: `Digest sent to ${emails.join(", ")}`,
      summary: { pursue: pursue.length, consider: consider.length, bahamasActionable: bahamasCount, bahamasTracked },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.put("/tender-digest-settings", async (req, res) => {
  const { emails, enabled } = req.body as { emails?: string[]; enabled?: boolean };
  const settings = await getOrCreateDigestSettings();
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (emails !== undefined) {
    const validation = validateDigestRecipients(emails);
    if (validation.invalid.length > 0) {
      res.status(400).json({
        error: "One or more recipient email addresses are invalid",
        invalid: validation.invalid,
      });
      return;
    }
    updates.emails = JSON.stringify(validation.emails);
  }
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
    const to = req.body?.to ?? "j.aymes@onwrdadvisors.com";
    const html = `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#fff;background:#0a0a0a;padding:32px;border-radius:8px">
  <img src="https://onwrdadvisors.com/wp-content/uploads/2024/01/onwrd-logo-white.png" style="height:36px;margin-bottom:24px" alt="ONWRD"/>
  <h2 style="color:#fff;margin-bottom:4px">Action Required: AI Features Offline</h2>
  <p style="color:#888;margin-top:0;font-size:13px">${new Date().toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" })}</p>
  <div style="background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:16px;margin:20px 0">
    <p style="color:#f87171;font-weight:600;margin:0 0 8px">⚠️ AI features are currently offline</p>
    <p style="color:#aaa;margin:0;font-size:14px">The OpenAI API key on the ONWRD Proposal Desk has exceeded its billing quota. Proposal generation and AI scoring are unavailable. Tender crawling and keyword scoring are still running normally.</p>
  </div>
  <p style="color:#fff;font-size:15px;font-weight:600;margin-bottom:12px">To restore AI features, choose one of the following:</p>
  <div style="background:#0f1f0f;border:1px solid #1a3a1a;border-radius:6px;padding:16px;margin-bottom:12px">
    <p style="color:#4ade80;font-weight:700;margin:0 0 6px">Option 1 — Google Gemini (free, fastest)</p>
    <ol style="color:#ccc;font-size:14px;margin:0;padding-left:18px;line-height:1.8">
      <li>Go to <a href="https://aistudio.google.com" style="color:#60a5fa">aistudio.google.com</a></li>
      <li>Sign in with a Google account → click <strong>Get API key</strong></li>
      <li>Copy the key and send it to the dev team to update in the system</li>
    </ol>
    <p style="color:#666;font-size:12px;margin:8px 0 0">No credit card needed. Free tier covers ~1,500 requests/day.</p>
  </div>
  <div style="background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:16px;margin-bottom:12px">
    <p style="color:#facc15;font-weight:700;margin:0 0 6px">Option 2 — Top up OpenAI (no code changes needed)</p>
    <ol style="color:#ccc;font-size:14px;margin:0;padding-left:18px;line-height:1.8">
      <li>Go to <a href="https://platform.openai.com/account/billing" style="color:#60a5fa">platform.openai.com/account/billing</a></li>
      <li>Add a payment method and purchase credit (minimum $10)</li>
      <li>The system will resume automatically — no dev work required</li>
    </ol>
  </div>
  <div style="background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:16px">
    <p style="color:#94a3b8;font-weight:700;margin:0 0 6px">Option 3 — Anthropic Claude</p>
    <ol style="color:#ccc;font-size:14px;margin:0;padding-left:18px;line-height:1.8">
      <li>Go to <a href="https://console.anthropic.com" style="color:#60a5fa">console.anthropic.com</a> → create account</li>
      <li>New accounts receive $5 free credit</li>
      <li>Copy API key and send to dev team</li>
    </ol>
  </div>
  <p style="color:#888;font-size:13px;margin-top:24px">📨 Please forward to <strong style="color:#ccc">r.dean@onwrdadvisors.com</strong> if they manage the API billing.</p>
  <p style="margin-top:16px;color:#555;font-size:12px">Sent from ONWRD Proposal Desk — automated billing alert</p>
</div>`;
    const { error } = await resend.emails.send({
      from: fromAddress,
      to: Array.isArray(to) ? to : [to],
      subject: `[ONWRD] Action required: AI features offline — options to restore`,
      html,
    });
    if (error) { res.status(500).json({ error: error.message }); return; }
    res.json({ message: `Billing alert sent to ${Array.isArray(to) ? to.join(", ") : to}` });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export default router;
