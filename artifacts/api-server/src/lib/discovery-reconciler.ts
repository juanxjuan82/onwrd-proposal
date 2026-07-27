/**
 * Centralised discovery reconciliation service.
 *
 * All paths that ingest crawler data (live crawl, backfill, manual trigger)
 * MUST go through reconcileDiscovery() so that scoring and eligibility logic
 * is never duplicated between live crawling and backfill.
 *
 * Responsibilities:
 *  1. Normalise fetched source data
 *  2. Upsert the discovered_tenders row (insert or update)
 *  3. Run deterministic keyword scoring
 *  4. Evaluate content quality and eligibility
 *  5. Persist rejection reasons for diagnostics
 *  6. Promote eligible discoveries idempotently
 *
 * Returns independent boolean flags per item so the caller can aggregate
 * batch-level counts without conflating DB insertion with eligibility.
 */

import { db, discoveredTendersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { type TenderOpportunity } from "../crawlers/base-adapter.js";
import { evaluateCrawlerEligibility } from "./crawler-eligibility.js";
import { promoteDiscoveredTender } from "./promote-discovered-tender.js";
import type { ScoredResult } from "./discovery-scoring.js";
import { scoreTender } from "./discovery-scoring.js";

export interface ReconcileResult {
  discoveryId: number;
  /** A new discovered_tender row was inserted (DB INSERT). */
  inserted: boolean;
  /** An existing row was updated — content changed, row was rescored. */
  updated: boolean;
  /** No meaningful content change — row left untouched. */
  unchanged: boolean;
  /** Passed the eligibility gate (regardless of insert/update/unchanged). */
  eligible: boolean;
  /** An Opportunity was created/linked (implies eligible === true). */
  promoted: boolean;
  /** Populated when eligible === false. */
  rejectionReasons?: string[];
  score?: ScoredResult;
  opportunityId?: number;
}

// ── Materialised-content hash ─────────────────────────────────────────────────
// We consider a record changed when title or description changes meaningfully.
function contentKey(title: string, description: string, deadline?: Date | null): string {
  return [
    title.trim().toLowerCase().slice(0, 120),
    description.trim().toLowerCase().slice(0, 300),
    deadline ? deadline.toISOString().slice(0, 10) : "",
  ].join("|");
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function reconcileDiscovery(
  sourceId: number,
  opp: TenderOpportunity,
): Promise<ReconcileResult> {

  // ① Find existing discovery by externalId (preferred) or URL
  type Row = typeof discoveredTendersTable.$inferSelect;
  let existing: Row | undefined;

  if (opp.externalId) {
    const rows = await db
      .select()
      .from(discoveredTendersTable)
      .where(
        and(
          eq(discoveredTendersTable.sourceId, sourceId),
          eq(discoveredTendersTable.externalId, opp.externalId),
        ),
      )
      .limit(1);
    existing = rows[0];
  }

  if (!existing && opp.url) {
    const rows = await db
      .select()
      .from(discoveredTendersTable)
      .where(eq(discoveredTendersTable.url, opp.url))
      .limit(1);
    existing = rows[0];
  }

  // ② Score the opportunity
  const score = scoreTender({
    title: opp.title,
    description: opp.description,
    sector: opp.sector,
    organization: opp.organization,
    country: opp.country,
    deadline: opp.deadline,
    url: opp.url,
  });

  // ③ Determine whether content changed (existing) or is brand new
  let discoveryId: number;
  let inserted = false;
  let updated = false;
  let unchanged = false;

  if (existing) {
    const prevKey = contentKey(existing.title, existing.description, existing.deadline);
    const newKey = contentKey(opp.title, opp.description, opp.deadline ?? null);

    if (prevKey === newKey) {
      discoveryId = existing.id;
      unchanged = true;

      if (existing.opportunityId !== null) {
        // Already promoted — nothing to do
        return { discoveryId, inserted: false, updated: false, unchanged: true, eligible: true, promoted: true, opportunityId: existing.opportunityId ?? undefined, score };
      }
      // Fall through to eligibility check below (rule change may make it eligible now)
    } else {
      // Content changed — update and rescore
      await db.update(discoveredTendersTable).set({
        title:                opp.title,
        organization:         opp.organization,
        url:                  opp.url ?? existing.url,
        deadline:             opp.deadline ?? existing.deadline,
        description:          opp.description,
        country:              opp.country ?? existing.country,
        sector:               opp.sector ?? existing.sector,
        valueAmount:          opp.valueAmount ?? existing.valueAmount,
        rawData:              opp.rawData ?? existing.rawData,
        fitScore:             score.fitScore,
        recommendation:       score.recommendation,
        scoringReasoning:     score.reasoning,
        geographyScore:       score.geographyScore,
        geoRegion:            score.geoRegion,
        bahamasAdvantageScore: score.bahamasAdvantageScore,
        confidence:           score.confidence,
        updatedAt:            new Date(),
      }).where(eq(discoveredTendersTable.id, existing.id));
      discoveryId = existing.id;
      updated = true;
    }
  } else {
    // Brand new — insert
    const [ins] = await db.insert(discoveredTendersTable).values({
      sourceId,
      externalId:           opp.externalId ?? null,
      title:                opp.title,
      organization:         opp.organization,
      url:                  opp.url ?? null,
      deadline:             opp.deadline ?? null,
      description:          opp.description,
      country:              opp.country ?? null,
      sector:               opp.sector ?? null,
      valueAmount:          opp.valueAmount ?? null,
      rawData:              opp.rawData ?? null,
      status:               "new",
      fitScore:             score.fitScore,
      recommendation:       score.recommendation,
      scoringReasoning:     score.reasoning,
      geographyScore:       score.geographyScore,
      geoRegion:            score.geoRegion,
      bahamasAdvantageScore: score.bahamasAdvantageScore,
      confidence:           score.confidence,
    }).returning({ id: discoveredTendersTable.id });
    discoveryId = ins.id;
    inserted = true;
  }

  // ④ Evaluate eligibility
  const eligibility = evaluateCrawlerEligibility({
    title:          opp.title,
    description:    opp.description,
    recommendation: score.recommendation,
    deadline:       opp.deadline,
  });

  // Persist rejection reasons — pass JS array directly to JSONB column (no JSON.stringify)
  await db.update(discoveredTendersTable).set({
    rejectionReasons: eligibility.eligible ? null : eligibility.rejectionReasons,
    updatedAt: new Date(),
  }).where(eq(discoveredTendersTable.id, discoveryId));

  if (!eligibility.eligible) {
    return {
      discoveryId,
      inserted,
      updated,
      unchanged,
      eligible: false,
      promoted: false,
      rejectionReasons: eligibility.rejectionReasons,
      score,
    };
  }

  // ⑤ Promote idempotently
  let opportunityId: number | undefined;
  try {
    const dest = eligibility.destination === "reviewing" ? "reviewing" : "new";
    const result = await promoteDiscoveredTender(discoveryId, dest);
    opportunityId = result.opportunityId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[reconciler] promote id=${discoveryId} failed: ${msg.slice(0, 100)}`);
    return {
      discoveryId,
      inserted,
      updated,
      unchanged,
      eligible: false,
      promoted: false,
      rejectionReasons: [`Promotion failed: ${msg.slice(0, 80)}`],
      score,
    };
  }

  return {
    discoveryId,
    inserted,
    updated,
    unchanged,
    eligible: true,
    promoted: true,
    opportunityId,
    score,
  };
}
