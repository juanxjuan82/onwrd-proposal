import { and, eq } from "drizzle-orm";
import {
  db,
  proposalsTable,
  tendersTable,
} from "@workspace/db";

type FailureInput = {
  proposalId: number;
  tenderId: number;
  generationAttemptId: string;
  generationError: string;
  proposalContent?: string;
  flaggedPhrases?: string[];
  reviewRequired?: boolean;
  unverifiedCredentials?: string[];
};

/**
 * Marks an owned generation attempt failed and restores its linked tender in
 * one transaction. A superseded worker returns false and changes neither row.
 */
export async function failOwnedProposalGeneration({
  proposalId,
  tenderId,
  generationAttemptId,
  generationError,
  proposalContent,
  flaggedPhrases,
  reviewRequired,
  unverifiedCredentials,
}: FailureInput): Promise<boolean> {
  type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

  return db.transaction(async (tx: DbTx) => {
    const failed = await tx
      .update(proposalsTable)
      .set({
        ...(proposalContent !== undefined ? { proposalContent } : {}),
        ...(flaggedPhrases !== undefined ? { flaggedPhrases } : {}),
        ...(reviewRequired !== undefined ? { reviewRequired } : {}),
        ...(unverifiedCredentials !== undefined ? { unverifiedCredentials } : {}),
        status: "draft",
        generationStatus: "failed",
        generationError,
        generationAttemptId: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(proposalsTable.id, proposalId),
          eq(proposalsTable.generationAttemptId, generationAttemptId),
        ),
      )
      .returning({ id: proposalsTable.id });

    if (failed.length === 0) return false;

    await tx
      .update(tendersTable)
      .set({
        proposalId,
        status: "draft",
        updatedAt: new Date(),
      })
      .where(eq(tendersTable.id, tenderId));

    return true;
  });
}