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
 * Returns an outcome per item so the caller can aggregate batch-level counts.
 */

import { db, discoveredTendersTable } from "@workspace/db";
import { eq, sql, and } from "drizzle-orm";
import { type TenderOpportunity } from "../crawlers/base-adapter.js";
import { evaluateCrawlerEligibility } from "./crawler-eligibility.js";
import { promoteDiscoveredTender } from "./promote-discovered-tender.js";

// ── Re-export the keyword scorer from crawlers/index so the reconciler
// can call it without creating a circular import.  The scorer is a pure
// function so the import is safe.
// We inline a lightweight version here to avoid circular deps.
// (The full keywordScore function lives in crawlers/index.ts.)
// We import it via a dynamic path that TypeScript can resolve.
import type { ScoredResult } from "./discovery-scoring.js";
import { scoreTender } from "./discovery-scoring.js";

export type ReconcileOutcome =
  | "inserted"    // new discovery, never seen before
  | "updated"     // existing discovery whose content changed — rescored
  | "unchanged"   // existing discovery, no meaningful change
  | "promoted"    // was ineligible/unlinked, now eligible and linked to a canonical Opportunity
  | "skipped";    // ineligible after scoring (stored for diagnostics)

export interface ReconcileResult {
  outcome: ReconcileOutcome;
  discoveryId: number;
  opportunityId?: number;
  rejectionReasons?: string[];
  score?: ScoredResult;
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
  let isNew = false;

  if (existing) {
    const prevKey = contentKey(existing.title, existing.description, existing.deadline);
    const newKey = contentKey(opp.title, opp.description, opp.deadline ?? null);

    if (prevKey === newKey) {
      // No meaningful change — skip rescoring / re-promotion work
      // but still re-evaluate eligibility if the record was never promoted
      discoveryId = existing.id;

      if (existing.opportunityId !== null) {
        // Already promoted — nothing to do
        return { outcome: "unchanged", discoveryId };
      }
      // Fall through to eligibility check below (content unchanged but maybe
      // a rule change since last run makes it eligible now)
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
    }
  } else {
    // Brand new — insert
    const [inserted] = await db.insert(discoveredTendersTable).values({
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
    discoveryId = inserted.id;
    isNew = true;
  }

  // ④ Evaluate eligibility
  const eligibility = evaluateCrawlerEligibility({
    title:          opp.title,
    description:    opp.description,
    recommendation: score.recommendation,
    deadline:       opp.deadline,
  });

  // Persist rejection reasons (overwrite on each reconcile)
  await db.update(discoveredTendersTable).set({
    rejectionReasons: eligibility.eligible ? null : JSON.stringify(eligibility.rejectionReasons),
    updatedAt: new Date(),
  }).where(eq(discoveredTendersTable.id, discoveryId));

  if (!eligibility.eligible) {
    return {
      outcome: "skipped",
      discoveryId,
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
    return { outcome: "skipped", discoveryId, rejectionReasons: [`Promotion failed: ${msg.slice(0, 80)}`], score };
  }

  // ⑥ Return outcome
  if (isNew) return { outcome: "inserted", discoveryId, opportunityId, score };

  // Existing record that was previously unlinked and just got promoted
  const wasLinked = (existing?.opportunityId ?? null) !== null;
  if (!wasLinked) return { outcome: "promoted", discoveryId, opportunityId, score };

  return { outcome: "updated", discoveryId, opportunityId, score };
}
