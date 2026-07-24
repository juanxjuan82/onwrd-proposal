import { db, discoveredTendersTable, tendersTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { applyDeterministicScore } from "./apply-deterministic-score.js";

/**
 * Transactional, concurrent-safe promotion of a raw crawler discovery
 * into a canonical Opportunity.
 *
 * Guarantees:
 * - SELECT FOR UPDATE prevents concurrent promotions from racing past the
 *   opportunityId check and creating duplicate Opportunities.
 * - Idempotent: if opportunityId is already set, returns it immediately.
 * - Sets sourceType = "crawler" on the canonical tenders row.
 * - For "new" destination: calls applyDeterministicScore within the same
 *   transaction so the insert, scoring, and link writes are fully atomic.
 * - For "reviewing" destination: inserts with status "pending_review" and
 *   skips deterministic scoring (the record needs human review first).
 */
export async function promoteDiscoveredTender(
  discoveredTenderId: number,
  destination: "new" | "reviewing" = "new",
): Promise<{ opportunityId: number }> {
  type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
  return db.transaction(async (tx: DbTx) => {
    const lockResult = await tx.execute(
      sql`SELECT id, title, organization, url, deadline, description,
                 country, sector, value_amount, opportunity_id
          FROM discovered_tenders
          WHERE id = ${discoveredTenderId}
          FOR UPDATE`,
    );

    const row = lockResult.rows[0] as {
      id: number;
      title: string;
      organization: string;
      url: string | null;
      deadline: string | null;
      description: string;
      country: string | null;
      sector: string | null;
      value_amount: string | null;
      opportunity_id: number | null;
    } | undefined;

    if (!row) {
      const err = new Error("Discovered tender not found");
      (err as NodeJS.ErrnoException).code = "NOT_FOUND";
      throw err;
    }

    // Idempotent: already promoted
    if (row.opportunity_id !== null) {
      return { opportunityId: row.opportunity_id };
    }

    const initialStatus = destination === "reviewing" ? "pending_review" : "opportunity_found";

    const [opportunity] = await tx
      .insert(tendersTable)
      .values({
        title:       row.title,
        agency:      row.organization,
        description: row.description || row.title,
        category:    row.sector ?? "General",
        deadline:    row.deadline ? new Date(row.deadline) : undefined,
        valueAmount: row.value_amount ?? undefined,
        sourceUrl:   row.url ?? undefined,
        rawText:     row.description || undefined,
        sourceType:  "crawler",
        status:      initialStatus,
      })
      .returning({ id: tendersTable.id });

    // Only run deterministic scoring for "new" destination opportunities —
    // "reviewing" records need human review before scoring drives decisions.
    if (destination === "new") {
      await applyDeterministicScore(tx, opportunity.id);
    }

    await tx
      .update(discoveredTendersTable)
      .set({ opportunityId: opportunity.id, updatedAt: new Date() })
      .where(eq(discoveredTendersTable.id, discoveredTenderId));

    return { opportunityId: opportunity.id };
  });
}
