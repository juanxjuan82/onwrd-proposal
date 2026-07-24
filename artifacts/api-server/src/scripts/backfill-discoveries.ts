/**
 * Backfill script: promotes all discovered_tenders that have not yet been
 * linked to a canonical Opportunity.
 *
 * Eligibility:
 *   - opportunityId IS NULL
 *   - status IN ('new', 'saved')
 *   - recommendation IN ('PURSUE', 'CONSIDER')
 *   - evaluateCrawlerEligibility() returns eligible === true
 *
 * SKIP recommendations, expired deadlines, boilerplate/title-only content,
 * and records without explicit ONWRD core phrases are stored but not promoted.
 *
 * Run sequentially to avoid lock contention.
 * Failed promotions are logged without printing tender contents or PII.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server run backfill-discoveries
 */
import { db, discoveredTendersTable } from "@workspace/db";
import { and, isNull, inArray } from "drizzle-orm";
import { promoteDiscoveredTender } from "../lib/promote-discovered-tender.js";
import { evaluateCrawlerEligibility } from "../lib/crawler-eligibility.js";

async function run() {
  // Only consider records where recommendation already says there may be value
  const candidates = await db
    .select({
      id:             discoveredTendersTable.id,
      title:          discoveredTendersTable.title,
      description:    discoveredTendersTable.description,
      recommendation: discoveredTendersTable.recommendation,
      deadline:       discoveredTendersTable.deadline,
    })
    .from(discoveredTendersTable)
    .where(
      and(
        isNull(discoveredTendersTable.opportunityId),
        inArray(discoveredTendersTable.status, ["new", "saved"]),
        inArray(discoveredTendersTable.recommendation, ["PURSUE", "CONSIDER"]),
      ),
    );

  console.log(`[backfill] Found ${candidates.length} PURSUE/CONSIDER candidates to evaluate.`);

  let promoted = 0;
  let ineligible = 0;
  let failed = 0;

  for (const row of candidates) {
    const eligibility = evaluateCrawlerEligibility({
      title:          row.title,
      description:    row.description,
      recommendation: row.recommendation ?? "SKIP",
      deadline:       row.deadline,
    });

    if (!eligibility.eligible) {
      ineligible++;
      console.log(
        `[backfill] id=${row.id} ineligible: ${eligibility.rejectionReasons[0] ?? "unknown"}`,
      );
      continue;
    }

    try {
      await promoteDiscoveredTender(row.id, eligibility.destination === "reviewing" ? "reviewing" : "new");
      promoted++;
    } catch (err) {
      failed++;
      const code = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
      const msg  = err instanceof Error ? err.message : String(err);
      console.error(`[backfill] id=${row.id} failed (${code}): ${msg.slice(0, 120)}`);
    }
  }

  console.log(
    `[backfill] Done. promoted=${promoted} ineligible=${ineligible} failed=${failed}`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("[backfill] Fatal error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
