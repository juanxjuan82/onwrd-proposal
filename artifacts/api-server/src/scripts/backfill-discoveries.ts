/**
 * Backfill script: promotes all discovered_tenders that have not yet been
 * linked to a canonical Opportunity.
 *
 * Eligibility: opportunityId IS NULL AND status IN ('new', 'saved')
 * (dismissed items are excluded — they were explicitly rejected)
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

async function run() {
  const eligible = await db
    .select({ id: discoveredTendersTable.id })
    .from(discoveredTendersTable)
    .where(
      and(
        isNull(discoveredTendersTable.opportunityId),
        inArray(discoveredTendersTable.status, ["new", "saved"]),
      ),
    );

  console.log(`[backfill] Found ${eligible.length} eligible discoveries to promote.`);

  let promoted = 0;
  let failed = 0;
  let skipped = 0;

  for (const { id } of eligible) {
    try {
      const result = await promoteDiscoveredTender(id);
      // Check whether this was truly new or idempotently returned
      if (result.opportunityId) {
        promoted++;
      } else {
        skipped++;
      }
    } catch (err) {
      failed++;
      // Log error type without printing discovery contents or PII
      const code = (err as NodeJS.ErrnoException).code ?? "UNKNOWN";
      const msg  = err instanceof Error ? err.message : String(err);
      console.error(`[backfill] id=${id} failed (${code}): ${msg.slice(0, 120)}`);
    }
  }

  console.log(`[backfill] Done. promoted=${promoted} skipped=${skipped} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("[backfill] Fatal error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
