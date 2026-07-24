/**
 * Reconcile crawler-sourced Opportunities against current eligibility rules.
 *
 * Finds all canonical Opportunities where sourceType="crawler" and re-evaluates
 * their crawler eligibility. Records that are clearly ineligible AND have not
 * progressed past early intake (no linked proposal, not already no_bid) are
 * candidates for marking as no_bid.
 *
 * Safety rules:
 *   - Never touches records that have a linked proposal.
 *   - Never deletes or hard-purges any record.
 *   - Dry-run by default — pass --apply to write changes.
 *   - Already-pursued / advanced-workflow records are skipped.
 *
 * Usage:
 *   # Dry-run (safe, no writes)
 *   pnpm --filter @workspace/api-server run reconcile-crawler-opportunities
 *
 *   # Apply changes
 *   pnpm --filter @workspace/api-server run reconcile-crawler-opportunities -- --apply
 */
import { db, tendersTable, discoveredTendersTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { evaluateCrawlerEligibility } from "../lib/crawler-eligibility.js";

// Statuses where we should NOT intervene — human or workflow already acted.
const SAFE_STATUSES = new Set([
  "screened",
  "analysing",
  "requirements_extracting",
  "bid_scoring",
  "strategy_generating",
  "requirements_extracted",
  "bid_started",
  "proposal_drafting",
  "needs_onwrd_input",
  "ready_for_review",
  "approved_for_export",
  "exported_to_drive",
  "no_bid",            // already decided
]);

async function run() {
  const applyChanges = process.argv.includes("--apply");

  if (!applyChanges) {
    console.log("[reconcile] DRY-RUN mode — no changes will be written. Pass --apply to apply.");
  } else {
    console.log("[reconcile] APPLY mode — ineligible records will be set to no_bid.");
  }

  // Fetch all crawler-sourced Opportunities in early-intake statuses
  const crawlerOpps = await db.execute(sql`
    SELECT
      t.id,
      t.title,
      t.status,
      t.description,
      d.recommendation,
      d.deadline,
      d.id AS discovery_id,
      (SELECT COUNT(*) FROM proposals p WHERE p.tender_id = t.id) AS proposal_count
    FROM tenders t
    LEFT JOIN discovered_tenders d ON d.opportunity_id = t.id
    WHERE t.source_type = 'crawler'
    ORDER BY t.id DESC
  `);

  type Row = {
    id: number;
    title: string;
    status: string;
    description: string;
    recommendation: string | null;
    deadline: string | null;
    discovery_id: number | null;
    proposal_count: string;
  };

  const rows = crawlerOpps.rows as Row[];
  console.log(`[reconcile] Found ${rows.length} crawler-sourced Opportunities.`);

  let skippedSafeStatus = 0;
  let skippedHasProposal = 0;
  let eligible = 0;
  let ineligibleDryRun = 0;
  let noBidApplied = 0;
  let errors = 0;

  for (const row of rows) {
    // Skip advanced-workflow and already-decided records
    if (SAFE_STATUSES.has(row.status)) {
      skippedSafeStatus++;
      continue;
    }

    // Skip records with any linked proposal — do not interfere with active work
    if (Number(row.proposal_count) > 0) {
      skippedHasProposal++;
      continue;
    }

    const result = evaluateCrawlerEligibility({
      title:          row.title,
      description:    row.description ?? "",
      recommendation: row.recommendation ?? "SKIP",
      deadline:       row.deadline,
    });

    if (result.eligible) {
      eligible++;
      continue;
    }

    // Record is ineligible and safe to reclassify
    const reasons = result.rejectionReasons.join(" | ");

    if (!applyChanges) {
      console.log(
        `[reconcile] WOULD set id=${row.id} "${row.title.slice(0, 60)}" → no_bid. Reasons: ${reasons}`,
      );
      ineligibleDryRun++;
    } else {
      try {
        await db
          .update(tendersTable)
          .set({ status: "no_bid", updatedAt: new Date() })
          .where(eq(tendersTable.id, row.id));
        console.log(
          `[reconcile] Set id=${row.id} "${row.title.slice(0, 60)}" → no_bid. Reasons: ${reasons}`,
        );
        noBidApplied++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[reconcile] Failed to update id=${row.id}: ${msg.slice(0, 100)}`);
        errors++;
      }
    }
  }

  console.log(
    applyChanges
      ? `[reconcile] Done. eligible=${eligible} no_bid_applied=${noBidApplied} skipped_status=${skippedSafeStatus} skipped_proposal=${skippedHasProposal} errors=${errors}`
      : `[reconcile] Dry-run complete. eligible=${eligible} would_no_bid=${ineligibleDryRun} skipped_status=${skippedSafeStatus} skipped_proposal=${skippedHasProposal}`,
  );

  process.exit(errors > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("[reconcile] Fatal error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
