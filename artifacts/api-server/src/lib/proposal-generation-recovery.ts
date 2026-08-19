import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger.js";

export const STALE_PROPOSAL_GENERATION_MS = 5 * 60 * 1000;

const ACTIVE_GENERATION_STATUSES = ["extracting", "strategizing", "drafting"] as const;
const TEST_FIXTURE_TITLE_PREFIX = "Call-Count Test Tender";
const TEST_FIXTURE_AGENCY = "Test Agency";

/**
 * Removes residue left by the historic call-count test fixture only.
 *
 * Both explicit markers are required. This deliberately cannot match an
 * ordinary proposal unless it uses the test fixture's exact agency and title
 * prefix together.
 */
export async function removeCallCountTestFixtures(): Promise<number> {
  try {
    return await db.transaction(async (tx) => {
      const fixtures = await tx.execute(sql`
        SELECT t.id AS tender_id, p.id AS proposal_id
        FROM tenders t
        LEFT JOIN proposals p ON p.tender_id = t.id
        WHERE t.title LIKE ${`${TEST_FIXTURE_TITLE_PREFIX}%`}
          AND t.agency = ${TEST_FIXTURE_AGENCY}
      `);
      const rows = fixtures.rows as Array<{ tender_id: number; proposal_id: number | null }>;

      for (const fixture of rows) {
        // These tables have no foreign key to proposals/tenders, so remove
        // test-only records explicitly before deleting the fixture itself.
        await tx.execute(sql`
          DELETE FROM ai_usage_log
          WHERE opportunity_id = ${fixture.tender_id}
             OR proposal_id = ${fixture.proposal_id}
        `);
        if (fixture.proposal_id !== null) {
          await tx.execute(sql`
            DELETE FROM notifications WHERE proposal_id = ${fixture.proposal_id}
          `);
          // Sections, generation runs, reviews, and exports cascade from this row.
          await tx.execute(sql`DELETE FROM proposals WHERE id = ${fixture.proposal_id}`);
        }
        // Tender requirements, strategies, and scores cascade from this row.
        await tx.execute(sql`DELETE FROM tenders WHERE id = ${fixture.tender_id}`);
      }

      if (rows.length > 0) {
        logger.info({ count: rows.length }, "Removed call-count test fixture residue");
      }
      return rows.length;
    });
  } catch (err) {
    logger.error({ err }, "Failed to remove call-count test fixture residue");
    return 0;
  }
}

/**
 * Converts expired background generation claims into a terminal retry state.
 * The proposal and linked opportunity are updated together, so the workspace
 * can stop polling and the next explicit user retry can safely claim the job.
 */
export async function recoverStaleProposalGenerations(): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - STALE_PROPOSAL_GENERATION_MS);

    return await db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        UPDATE proposals
        SET generation_status = 'failed',
            generation_error = CASE
              WHEN generation_status IS NULL THEN
                'Generation was interrupted before its phase could be recorded. Retry to start again.'
              ELSE
                'Generation was interrupted during ' || generation_status || '. Retry to start again.'
            END,
            generation_attempt_id = NULL,
            status = 'draft',
            updated_at = NOW()
        WHERE updated_at < ${cutoff}
          AND (
            generation_status IN (
              ${ACTIVE_GENERATION_STATUSES[0]},
              ${ACTIVE_GENERATION_STATUSES[1]},
              ${ACTIVE_GENERATION_STATUSES[2]}
            )
            OR (generation_status IS NULL AND status = 'proposal_drafting')
          )
        RETURNING id, tender_id
      `);
      const recovered = result.rows as Array<{ id: number; tender_id: number | null }>;

      for (const proposal of recovered) {
        if (proposal.tender_id !== null) {
          await tx.execute(sql`
            UPDATE tenders
            SET proposal_id = ${proposal.id},
                status = 'draft',
                updated_at = NOW()
            WHERE id = ${proposal.tender_id}
          `);
        }
      }

      if (recovered.length > 0) {
        logger.warn(
          { count: recovered.length, cutoff: cutoff.toISOString() },
          "Recovered stale proposal generation job(s)",
        );
      }
      return recovered.length;
    });
  } catch (err) {
    logger.error({ err }, "Failed to recover stale proposal generation jobs");
    return 0;
  }
}

/** Reconcile legacy test residue and jobs interrupted by a restart or handoff. */
export async function reconcileProposalGenerationState(): Promise<void> {
  await removeCallCountTestFixtures();
  await recoverStaleProposalGenerations();
}