import { db, tendersTable, bidScoresTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { scoreTender } from "./scoring-rules.js";

/**
 * Extract the Drizzle transaction type so we can accept both `db` and an
 * active `tx` without importing internal Drizzle types.
 */
type TxType = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = TxType | typeof db;

/**
 * Deterministic (no-AI) bid scoring for a canonical Opportunity.
 *
 * Accepts the active db instance or a Drizzle transaction so that
 * opportunity creation, scoring, and downstream linkage are atomic.
 *
 * - Pass `db` from standalone call sites (update, re-score).
 * - Pass `tx` from promote-discovered-tender and prospect-intake
 *   handlers so the three writes (insert tender, insert bid_score,
 *   update tender score) are part of a single atomic transaction.
 */
export async function applyDeterministicScore(
  executor: Executor,
  tenderId: number,
) {
  const [tender] = await executor
    .select()
    .from(tendersTable)
    .where(eq(tendersTable.id, tenderId));

  if (!tender) throw new Error(`Tender ${tenderId} not found`);

  const result = scoreTender({
    title:       tender.title,
    agency:      tender.agency,
    category:    tender.category,
    description: tender.description,
    deadline:    tender.deadline ?? null,
    valueAmount: tender.valueAmount ?? null,
    rawText:     tender.rawText ?? null,
    contactInfo: tender.contactInfo ?? null,
  });

  const [bidScore] = await executor
    .insert(bidScoresTable)
    .values({
      tenderId,
      fitScore:          result.fitScore,
      fitLevel:          result.fitLevel,
      reasoning:         result.reasoning,
      flags:             JSON.stringify(result.flags),
      completenessScore: result.completenessScore,
      missingFields:     JSON.stringify(result.missingFields),
    })
    .returning();

  await executor
    .update(tendersTable)
    .set({ recommendationScore: result.fitScore, updatedAt: new Date() })
    .where(eq(tendersTable.id, tenderId));

  return bidScore;
}
