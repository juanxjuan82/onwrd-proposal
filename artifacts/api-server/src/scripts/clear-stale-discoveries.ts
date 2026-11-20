/**
 * Clear crawler discoveries that can no longer be bid on.
 *
 * A discovery is stale when its deadline has passed, or (Bahamas Gov source)
 * when it is an archive row, contract award, job post, navigation link or a
 * link to another organisation's portal — the rows the adapter stored before
 * it learned to filter them.
 *
 * What it changes (only with --apply):
 *   - the discovery is set to "dismissed" (hidden from the inbox, not deleted);
 *   - an Opportunity created from it is set to "no_bid", unless a person or
 *     the workflow has already acted on it or it has a proposal.
 *
 * Safety rules:
 *   - Dry-run by default — pass --apply to write changes.
 *   - Never deletes anything. Discoveries you marked "saved" are left alone.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server run clear-stale-discoveries
 *   pnpm --filter @workspace/api-server run clear-stale-discoveries -- --apply
 */
import { db, tendersTable, discoveredTendersTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { staleDiscoveryReason } from "../lib/stale-discoveries.js";

// Opportunity statuses that are still untouched intake; anything else means a
// person or the workflow has already acted, so it is left alone.
const UNTOUCHED_OPPORTUNITY_STATUSES = new Set(["opportunity_found", "pending_review"]);

async function run() {
  const apply = process.argv.includes("--apply");
  console.log(apply
    ? "[clear-stale] APPLY mode — stale items will be dismissed."
    : "[clear-stale] DRY-RUN mode — no changes will be written. Pass --apply to apply.");

  const result = await db.execute(sql`
    SELECT
      d.id, d.title, d.url, d.deadline, d.opportunity_id,
      s.adapter_type,
      t.status AS opportunity_status,
      (SELECT COUNT(*) FROM proposals p WHERE p.tender_id = t.id) AS proposal_count
    FROM discovered_tenders d
    LEFT JOIN tender_sources s ON s.id = d.source_id
    LEFT JOIN tenders t ON t.id = d.opportunity_id
    WHERE d.status = 'new'
    ORDER BY d.id
  `);
  type Row = {
    id: number; title: string; url: string | null; deadline: string | null;
    opportunity_id: number | null; adapter_type: string | null;
    opportunity_status: string | null; proposal_count: string | null;
  };
  const rows = result.rows as Row[];
  console.log(`[clear-stale] Checking ${rows.length} discoveries still marked "new".`);

  const now = new Date();
  const counts: Record<string, number> = {};
  let dismissed = 0;
  let opportunitiesClosed = 0;
  let opportunitiesKept = 0;
  let errors = 0;

  for (const row of rows) {
    const reason = staleDiscoveryReason({
      adapterType: row.adapter_type, title: row.title, url: row.url, deadline: row.deadline,
    }, now);
    if (!reason) continue;
    counts[reason] = (counts[reason] ?? 0) + 1;

    const closeOpportunity = row.opportunity_id !== null &&
      UNTOUCHED_OPPORTUNITY_STATUSES.has(row.opportunity_status ?? "") &&
      Number(row.proposal_count ?? 0) === 0;
    const opportunityNote = row.opportunity_id === null
      ? ""
      : closeOpportunity
        ? ` + opportunity ${row.opportunity_id} → no_bid`
        : ` (opportunity ${row.opportunity_id} left alone: status "${row.opportunity_status}")`;
    console.log(`[clear-stale] ${apply ? "Dismiss" : "WOULD dismiss"} id=${row.id} [${reason}] "${row.title.slice(0, 70)}"${opportunityNote}`);

    if (row.opportunity_id !== null && !closeOpportunity) opportunitiesKept++;
    if (closeOpportunity) opportunitiesClosed++;
    dismissed++;
    if (!apply) continue;

    try {
      await db.update(discoveredTendersTable)
        .set({ status: "dismissed", updatedAt: now })
        .where(and(eq(discoveredTendersTable.id, row.id), eq(discoveredTendersTable.status, "new")));
      if (closeOpportunity && row.opportunity_id !== null && row.opportunity_status) {
        await db.update(tendersTable)
          .set({ status: "no_bid", updatedAt: now })
          .where(and(
            eq(tendersTable.id, row.opportunity_id),
            eq(tendersTable.status, row.opportunity_status),
          ));
      }
    } catch (err) {
      errors++;
      console.error(`[clear-stale] Failed on id=${row.id}: ${(err instanceof Error ? err.message : String(err)).slice(0, 100)}`);
    }
  }

  const summary = Object.entries(counts).map(([reason, count]) => `${reason}=${count}`).join(" ") || "none";
  console.log(
    `[clear-stale] ${apply ? "Done" : "Dry-run complete"}. ` +
    `${apply ? "dismissed" : "would_dismiss"}=${dismissed} (${summary}) ` +
    `opportunities_${apply ? "closed" : "to_close"}=${opportunitiesClosed} opportunities_left_alone=${opportunitiesKept} errors=${errors}`,
  );
  process.exit(errors > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("[clear-stale] Fatal error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
