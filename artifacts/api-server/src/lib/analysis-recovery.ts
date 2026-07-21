import { db } from "@workspace/db";
import { tendersTable } from "@workspace/db";
import { and, inArray, lt, isNotNull } from "drizzle-orm";
import { STALE_JOB_MS, ANALYSIS_ACTIVE_STATUSES } from "./analysis-utils.js";

/**
 * On server start, mark any tender that has been stuck in an active analysis
 * status for more than STALE_JOB_MS (5 minutes) as analysis_failed.
 *
 * This recovers jobs abandoned by a server restart or deployment swap.
 */
export async function recoverStaleAnalysisJobs(): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - STALE_JOB_MS);

    const stale = await db
      .select({ id: tendersTable.id, status: tendersTable.status })
      .from(tendersTable)
      .where(
        and(
          inArray(tendersTable.status, [...ANALYSIS_ACTIVE_STATUSES]),
          isNotNull(tendersTable.analysisStartedAt),
          lt(tendersTable.analysisStartedAt, cutoff),
        ),
      );

    if (stale.length === 0) return 0;

    await db
      .update(tendersTable)
      .set({
        status: "analysis_failed",
        failedStep: "abandoned",
        failedErrorCode: "abandoned",
        analysisCompletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        inArray(
          tendersTable.id,
          stale.map((s) => s.id),
        ),
      );

    console.log(
      `[analysis-recovery] Marked ${stale.length} stale job(s) as analysis_failed` +
        ` (started before ${cutoff.toISOString()})`,
    );
    return stale.length;
  } catch (err) {
    console.error(
      "[analysis-recovery] Failed to recover stale jobs:",
      err instanceof Error ? err.message : String(err),
    );
    return 0;
  }
}
