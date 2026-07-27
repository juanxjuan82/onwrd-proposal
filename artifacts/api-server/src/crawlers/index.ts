import { db } from "@workspace/db";
import {
  tenderSourcesTable,
  discoveredTendersTable,
  crawlerRunsTable,
  crawlerLockTable,
  crawlBatchesTable,
} from "@workspace/db";
import { eq, sql, and, isNull, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { WorldBankAdapter } from "./world-bank.js";
import { UNGMAdapter } from "./ungm.js";
import { IDBAdapter } from "./idb.js";
import { CDBAdapter } from "./cdb.js";
import { BahamasGovAdapter } from "./bahamas-gov.js";
import { CTOAdapter } from "./cto.js";
import { CARICOMAdapter } from "./caricom.js";
import { EUCaribbeanAdapter } from "./eu-caribbean.js";
import { type TenderSourceAdapter } from "./base-adapter.js";
import { reconcileDiscovery } from "../lib/discovery-reconciler.js";
import { scoreTender } from "../lib/discovery-scoring.js";

function getAdapter(adapterType: string): TenderSourceAdapter | null {
  switch (adapterType) {
    case "world_bank":   return new WorldBankAdapter();
    case "ungm":         return new UNGMAdapter();
    case "idb":          return new IDBAdapter();
    case "cdb":          return new CDBAdapter();
    case "bahamas_gov":  return new BahamasGovAdapter();
    case "cto":          return new CTOAdapter();
    case "caricom":      return new CARICOMAdapter();
    case "eu_caribbean": return new EUCaribbeanAdapter();
    default:             return null;
  }
}

// ── DB-backed crawl lock (prevents overlap across restarts & instances) ───────
const CRAWL_LOCK_KEY = "default";
const LOCK_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours — 2× max expected crawl duration
const INSTANCE_ID = randomUUID();

/** @internal Exported for testing only — prefer testing behaviour through runCrawler(). */
export async function acquireCrawlLock(): Promise<boolean> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);

  await db
    .delete(crawlerLockTable)
    .where(sql`${crawlerLockTable.lockKey} = ${CRAWL_LOCK_KEY} AND ${crawlerLockTable.expiresAt} < ${now}`);

  const result = await db
    .insert(crawlerLockTable)
    .values({ lockKey: CRAWL_LOCK_KEY, acquiredAt: now, expiresAt, instanceId: INSTANCE_ID })
    .onConflictDoNothing()
    .returning({ lockKey: crawlerLockTable.lockKey });

  return result.length > 0;
}

/** @internal Exported for testing only. */
export async function releaseCrawlLock(): Promise<void> {
  await db
    .delete(crawlerLockTable)
    .where(sql`${crawlerLockTable.lockKey} = ${CRAWL_LOCK_KEY} AND ${crawlerLockTable.instanceId} = ${INSTANCE_ID}`);
}

export async function isCrawlRunning(): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .select({ expiresAt: crawlerLockTable.expiresAt })
    .from(crawlerLockTable)
    .where(sql`${crawlerLockTable.lockKey} = ${CRAWL_LOCK_KEY} AND ${crawlerLockTable.expiresAt} > ${now}`);
  return rows.length > 0;
}

// ── Rejection counts accumulator ─────────────────────────────────────────────
function mergeRejectionCounts(
  acc: Record<string, number>,
  reasons: string[],
): Record<string, number> {
  const out = { ...acc };
  for (const r of reasons) {
    const key = r.slice(0, 80);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

// ── Backfill / reconciliation of ALL unpromoted non-expired discoveries ───────
// Examines every discovered_tender that has no linked canonical Opportunity
// and is not expired. Rescores each and promotes it if it now qualifies.
// Idempotent and safe under concurrent promotion attempts.
export interface BackfillResult {
  evaluated: number;
  rescored: number;
  promoted: number;
  unchanged: number;
  rejected: number;
  rejectionCounts: Record<string, number>;
}

export async function backfillPromotions(): Promise<BackfillResult> {
  const now = new Date();

  // ALL unpromoted, non-expired discoveries — not pre-filtered by recommendation
  const items = await db
    .select()
    .from(discoveredTendersTable)
    .where(
      and(
        isNull(discoveredTendersTable.opportunityId),
        or(
          isNull(discoveredTendersTable.deadline),
          sql`${discoveredTendersTable.deadline} > ${now}`,
        ),
      ),
    );

  let rescored = 0;
  let promoted = 0;
  let unchanged = 0;
  let rejected = 0;
  let rejectionCounts: Record<string, number> = {};

  for (const item of items) {
    // Recompute score from current content
    const score = scoreTender({
      title:        item.title,
      description:  item.description,
      sector:       item.sector,
      organization: item.organization,
      country:      item.country,
      deadline:     item.deadline,
    });

    const scoreChanged =
      score.recommendation !== item.recommendation ||
      score.fitScore !== item.fitScore;

    if (scoreChanged) {
      await db.update(discoveredTendersTable).set({
        fitScore:             score.fitScore,
        recommendation:       score.recommendation,
        scoringReasoning:     score.reasoning,
        geographyScore:       score.geographyScore,
        geoRegion:            score.geoRegion,
        bahamasAdvantageScore: score.bahamasAdvantageScore,
        confidence:           score.confidence,
        updatedAt:            new Date(),
      }).where(eq(discoveredTendersTable.id, item.id));
      rescored++;
    }

    // Re-evaluate eligibility with freshly computed score
    const { evaluateCrawlerEligibility } = await import("../lib/crawler-eligibility.js");
    const { promoteDiscoveredTender } = await import("../lib/promote-discovered-tender.js");

    const eligibility = evaluateCrawlerEligibility({
      title:          item.title,
      description:    item.description,
      recommendation: score.recommendation,
      deadline:       item.deadline,
    });

    if (!eligibility.eligible) {
      rejected++;
      rejectionCounts = mergeRejectionCounts(rejectionCounts, eligibility.rejectionReasons);
      await db.update(discoveredTendersTable).set({
        rejectionReasons: JSON.stringify(eligibility.rejectionReasons),
        updatedAt: new Date(),
      }).where(eq(discoveredTendersTable.id, item.id));
      continue;
    }

    // Promote idempotently
    try {
      const dest = eligibility.destination === "reviewing" ? "reviewing" : "new";
      await promoteDiscoveredTender(item.id, dest);
      promoted++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[backfill] promote id=${item.id} failed: ${msg.slice(0, 80)}`);
      rejected++;
    }
  }

  unchanged = items.length - rescored - promoted - rejected;
  if (unchanged < 0) unchanged = 0;

  return { evaluated: items.length, rescored, promoted, unchanged, rejected, rejectionCounts };
}

// ── Main crawl runner ────────────────────────────────────────────────────────
export interface CrawlBatchResult {
  batchId: string;
  sourcesAttempted: number;
  sourcesSucceeded: number;
  sourcesFailed: number;
  fetched: number;
  inserted: number;
  updated: number;
  eligible: number;
  promoted: number;
  rejected: number;
  unchanged: number;
  perSourceErrors: Record<string, string>;
  rejectionCounts: Record<string, number>;
}

export async function runCrawler(sourceId?: number): Promise<CrawlBatchResult> {
  // DB-backed overlap prevention
  const acquired = await acquireCrawlLock();
  if (!acquired) {
    throw new Error("A crawl is already in progress — skipping to prevent overlap.");
  }

  const batchId = randomUUID();

  // Create a batch row so the frontend can poll it
  await db.insert(crawlBatchesTable).values({
    id:       batchId,
    status:   "running",
    startedAt: new Date(),
  });

  const sources = sourceId
    ? await db.select().from(tenderSourcesTable).where(eq(tenderSourcesTable.id, sourceId))
    : await db.select().from(tenderSourcesTable).where(eq(tenderSourcesTable.active, true));

  // Batch-level aggregates
  let sourcesAttempted = 0;
  let sourcesSucceeded = 0;
  let sourcesFailed = 0;
  let batchFetched = 0;
  let batchInserted = 0;
  let batchUpdated = 0;
  let batchEligible = 0;
  let batchPromoted = 0;
  let batchRejected = 0;
  let batchUnchanged = 0;
  const perSourceErrors: Record<string, string> = {};
  let batchRejectionCounts: Record<string, number> = {};

  try {
    for (const source of sources) {
      const adapter = getAdapter(source.adapterType);
      if (!adapter) continue;

      sourcesAttempted++;

      const [run] = await db.insert(crawlerRunsTable).values({
        batchId,
        sourceId:  source.id,
        startedAt: new Date(),
        status:    "running",
      }).returning();

      // Per-source aggregates
      let srcFetched = 0;
      let srcInserted = 0;
      let srcUpdated = 0;
      let srcEligible = 0;
      let srcPromoted = 0;
      let srcRejected = 0;
      let srcUnchanged = 0;
      let srcRequestsAttempted = 0;
      let srcRequestsSucceeded = 0;
      let srcWarnings: string[] = [];
      const srcRejectionCounts: Record<string, number> = {};

      try {
        const fetchResult = await adapter.fetchOpportunities();
        srcRequestsAttempted = fetchResult.requestsAttempted;
        srcRequestsSucceeded = fetchResult.requestsSucceeded;
        srcWarnings = fetchResult.warnings;
        srcFetched = fetchResult.opportunities.length;
        batchFetched += srcFetched;

        for (const opp of fetchResult.opportunities) {
          try {
            const result = await reconcileDiscovery(source.id, opp);

            switch (result.outcome) {
              case "inserted":
                srcInserted++;
                // Newly inserted but ineligible — counted in rejected below via skipped
                break;
              case "updated":
                srcUpdated++;
                break;
              case "unchanged":
                srcUnchanged++;
                break;
              case "promoted":
                srcPromoted++;
                srcEligible++;
                break;
              case "skipped":
                srcRejected++;
                if (result.rejectionReasons) {
                  for (const r of result.rejectionReasons) {
                    const k = r.slice(0, 80);
                    srcRejectionCounts[k] = (srcRejectionCounts[k] ?? 0) + 1;
                  }
                }
                break;
            }

            // Inserted items that were also promoted
            if (result.outcome === "inserted" && result.opportunityId) {
              srcPromoted++;
              srcEligible++;
            } else if (result.outcome === "inserted" && !result.opportunityId) {
              srcRejected++;
              if (result.rejectionReasons) {
                for (const r of result.rejectionReasons) {
                  const k = r.slice(0, 80);
                  srcRejectionCounts[k] = (srcRejectionCounts[k] ?? 0) + 1;
                }
              }
            }
          } catch (itemErr) {
            const msg = itemErr instanceof Error ? itemErr.message : String(itemErr);
            console.warn(`[crawler] reconcile failed for source=${source.id}: ${msg.slice(0, 100)}`);
            srcRejected++;
          }
        }

        // Merge per-source rejection counts into batch
        for (const [k, v] of Object.entries(srcRejectionCounts)) {
          batchRejectionCounts[k] = (batchRejectionCounts[k] ?? 0) + v;
        }

        // Determine run status
        const runStatus = srcRequestsAttempted > 0 && srcRequestsSucceeded === 0
          ? "failed"
          : srcWarnings.length > 0 ? "partial"
          : "success";

        if (runStatus === "failed" || runStatus === "partial") {
          sourcesFailed++;
        } else {
          sourcesSucceeded++;
        }

        await db.update(crawlerRunsTable).set({
          completedAt:         new Date(),
          status:              runStatus,
          requestsAttempted:   srcRequestsAttempted,
          requestsSucceeded:   srcRequestsSucceeded,
          warnings:            srcWarnings.length > 0 ? JSON.stringify(srcWarnings) : null,
          itemsFound:          srcFetched,
          itemsNew:            srcInserted,
          itemsUpdated:        srcUpdated,
          itemsEligible:       srcEligible,
          itemsPromoted:       srcPromoted,
          itemsRejected:       srcRejected,
          itemsUnchanged:      srcUnchanged,
          rejectionCounts:     Object.keys(srcRejectionCounts).length > 0
            ? JSON.stringify(srcRejectionCounts)
            : null,
          aiCallCount:         0,
          aiFallbackCount:     0,
          aiQuotaError:        false,
        }).where(eq(crawlerRunsTable.id, run.id));

        await db.update(tenderSourcesTable).set({
          lastCheckedAt:   new Date(),
          ...(runStatus !== "failed" ? { lastSuccessAt: new Date() } : {}),
          itemsFoundCount: source.itemsFoundCount + srcInserted,
          updatedAt:       new Date(),
        }).where(eq(tenderSourcesTable.id, source.id));

        batchInserted += srcInserted;
        batchUpdated  += srcUpdated;
        batchEligible += srcEligible;
        batchPromoted += srcPromoted;
        batchRejected += srcRejected;
        batchUnchanged += srcUnchanged;

      } catch (err) {
        // Adapter threw — record as failed source
        sourcesFailed++;
        const msg = err instanceof Error ? err.message : String(err);
        perSourceErrors[String(source.id)] = msg.slice(0, 200);

        await db.update(crawlerRunsTable).set({
          completedAt:  new Date(),
          status:       "failed",
          errorMessage: msg.slice(0, 400),
          aiCallCount:  0,
          aiFallbackCount: 0,
          aiQuotaError: false,
        }).where(eq(crawlerRunsTable.id, run.id));

        await db.update(tenderSourcesTable).set({
          lastCheckedAt: new Date(),
          updatedAt:     new Date(),
        }).where(eq(tenderSourcesTable.id, source.id));
      }
    }

    // ── Run backfill after each crawl to catch any newly eligible items ──────
    try {
      const bf = await backfillPromotions();
      if (bf.promoted > 0) {
        batchPromoted  += bf.promoted;
        batchEligible  += bf.promoted;
        console.log(`[crawler] backfill promoted ${bf.promoted} additional items (${bf.evaluated} evaluated).`);
      }
    } catch (bfErr) {
      console.warn("[crawler] backfill failed:", bfErr instanceof Error ? bfErr.message : String(bfErr));
    }

    // Determine overall batch status
    const batchStatus = sourcesAttempted === 0 ? "failed"
      : sourcesFailed === sourcesAttempted ? "failed"
      : sourcesFailed > 0 ? "partial"
      : "success";

    await db.update(crawlBatchesTable).set({
      completedAt:      new Date(),
      status:           batchStatus,
      sourcesAttempted,
      sourcesSucceeded,
      sourcesFailed,
      fetched:          batchFetched,
      inserted:         batchInserted,
      updated:          batchUpdated,
      eligible:         batchEligible,
      promoted:         batchPromoted,
      rejected:         batchRejected,
      unchanged:        batchUnchanged,
      perSourceErrors:  Object.keys(perSourceErrors).length > 0 ? JSON.stringify(perSourceErrors) : null,
      rejectionCounts:  Object.keys(batchRejectionCounts).length > 0 ? JSON.stringify(batchRejectionCounts) : null,
    }).where(eq(crawlBatchesTable.id, batchId));

  } finally {
    await releaseCrawlLock();
  }

  return {
    batchId,
    sourcesAttempted,
    sourcesSucceeded,
    sourcesFailed,
    fetched: batchFetched,
    inserted: batchInserted,
    updated: batchUpdated,
    eligible: batchEligible,
    promoted: batchPromoted,
    rejected: batchRejected,
    unchanged: batchUnchanged,
    perSourceErrors,
    rejectionCounts: batchRejectionCounts,
  };
}

// ── Re-score all existing discovered_tenders with current keyword engine ──────
// Updates scores in-place but does not promote.
// Use backfillPromotions() to also promote newly eligible records.
export async function rescoreWithKeywords(): Promise<number> {
  const items = await db.select().from(discoveredTendersTable);
  let count = 0;
  for (const item of items) {
    const score = scoreTender({
      title:        item.title,
      description:  item.description,
      sector:       item.sector,
      organization: item.organization,
      country:      item.country,
      deadline:     item.deadline,
    });
    await db.update(discoveredTendersTable).set({
      fitScore:             score.fitScore,
      recommendation:       score.recommendation,
      scoringReasoning:     score.reasoning,
      geographyScore:       score.geographyScore,
      geoRegion:            score.geoRegion,
      bahamasAdvantageScore: score.bahamasAdvantageScore,
      confidence:           score.confidence,
      updatedAt:            new Date(),
    }).where(eq(discoveredTendersTable.id, item.id));
    count++;
  }
  return count;
}

// ── Seed default sources ─────────────────────────────────────────────────────
export async function seedDefaultSources(): Promise<void> {
  const existing = await db.select().from(tenderSourcesTable);
  if (existing.length > 0) {
    const existingTypes = new Set(existing.map((s) => s.adapterType));
    const newSources = [
      { name: "Caribbean Tourism Organization", sourceType: "regional", url: "https://www.caribtourism.com/", adapterType: "cto" },
      { name: "CARICOM Secretariat", sourceType: "regional", url: "https://caricom.org/", adapterType: "caricom" },
      { name: "EU Caribbean Development Fund", sourceType: "development_fund", url: "https://www.cariforum.org/", adapterType: "eu_caribbean" },
    ];
    for (const s of newSources) {
      if (!existingTypes.has(s.adapterType)) {
        await db.insert(tenderSourcesTable).values({ ...s, active: true });
      }
    }
    return;
  }

  const defaults = [
    { name: "World Bank Procurement", sourceType: "development_bank", url: "https://search.worldbank.org/api/v2/procnotices", adapterType: "world_bank" },
    { name: "UNDP Procurement Notices", sourceType: "un", url: "https://procurement-notices.undp.org/", adapterType: "ungm" },
    { name: "Inter-American Development Bank", sourceType: "development_bank", url: "https://www.iadb.org/en/projects/all", adapterType: "idb" },
    { name: "Caribbean Development Bank", sourceType: "development_bank", url: "https://www.caribank.org/", adapterType: "cdb" },
    { name: "Bahamas Government Procurement", sourceType: "government", url: "https://www.bahamas.gov.bs/wps/portal/public/gov/government/news", adapterType: "bahamas_gov" },
    { name: "Caribbean Tourism Organization", sourceType: "regional", url: "https://www.caribtourism.com/", adapterType: "cto" },
    { name: "CARICOM Secretariat", sourceType: "regional", url: "https://caricom.org/", adapterType: "caricom" },
    { name: "EU Caribbean Development Fund", sourceType: "development_fund", url: "https://www.cariforum.org/", adapterType: "eu_caribbean" },
  ];

  for (const s of defaults) {
    await db.insert(tenderSourcesTable).values({ ...s, active: true });
  }
}

// ── Seed default search profiles ─────────────────────────────────────────────
export async function seedDefaultSearchProfiles(): Promise<void> {
  const { tenderSearchProfilesTable } = await import("@workspace/db");
  const existing = await db.select().from(tenderSearchProfilesTable);
  if (existing.length > 0) return;

  const profiles = [
    {
      name: "Communications & Marketing",
      description: "Core ONWRD practice area",
      keywords: JSON.stringify(["communications", "marketing", "campaign", "branding", "media", "public awareness", "digital engagement", "stakeholder engagement", "creative", "content"]),
      excludedKeywords: JSON.stringify([]),
    },
    {
      name: "Development Sector",
      description: "NGO/multilateral comms work",
      keywords: JSON.stringify(["community engagement", "behavior change", "knowledge dissemination", "capacity building", "social impact", "awareness campaign"]),
      excludedKeywords: JSON.stringify([]),
    },
    {
      name: "Tourism & Destination",
      description: "Tourism marketing opportunities",
      keywords: JSON.stringify(["destination marketing", "tourism", "visitor experience", "brand strategy", "promotion", "hospitality"]),
      excludedKeywords: JSON.stringify([]),
    },
    {
      name: "Bahamas & Caribbean",
      description: "Geo-priority opportunities",
      keywords: JSON.stringify(["bahamas", "caribbean", "caricom", "oecs", "cdb", "cto"]),
      excludedKeywords: JSON.stringify([]),
    },
  ];

  for (const p of profiles) {
    await db.insert(tenderSearchProfilesTable).values(p);
  }
}
