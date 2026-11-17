import assert from "node:assert/strict";
import { afterEach, before, describe, it } from "node:test";
import { db, proposalsTable, proposalSectionsTable, tendersTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { dbReady } from "../app.js";
import {
  recoverStaleProposalGenerations,
  removeCallCountTestFixtures,
  STALE_PROPOSAL_GENERATION_MS,
} from "./proposal-generation-recovery.js";
import { generateProposalDraftAndPersist } from "./proposal-draft-service.js";
import { __setInvokeAISpy } from "./ai-gateway.js";
import { failOwnedProposalGeneration } from "./proposal-generation-ownership.js";

describe("proposal generation recovery", () => {
  const createdTenderIds = new Set<number>();

  before(async () => {
    await dbReady;
  });

  afterEach(async () => {
    __setInvokeAISpy(null);
    for (const tenderId of createdTenderIds) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`
          DELETE FROM ai_usage_log
          WHERE opportunity_id = ${tenderId}
             OR proposal_id IN (SELECT id FROM proposals WHERE tender_id = ${tenderId})
        `);
        await tx.execute(sql`
          DELETE FROM notifications
          WHERE proposal_id IN (SELECT id FROM proposals WHERE tender_id = ${tenderId})
        `);
        await tx.execute(sql`DELETE FROM proposals WHERE tender_id = ${tenderId}`);
        await tx.execute(sql`DELETE FROM tenders WHERE id = ${tenderId}`);
      });
    }
    createdTenderIds.clear();
  });

  async function createTender(title: string, agency: string): Promise<number> {
    const [row] = await db
      .insert(tendersTable)
      .values({
        title,
        agency,
        description: "Recovery test tender.",
        category: "General",
        status: "proposal_drafting",
        recommendationScore: 0,
      })
      .returning({ id: tendersTable.id });
    createdTenderIds.add(row.id);
    return row.id;
  }

  async function createProposal(
    tenderId: number,
    generationStatus: string | null,
    updatedAt: Date,
  ): Promise<number> {
    const [proposal] = await db
      .insert(proposalsTable)
      .values({
        clientName: "Recovery Test Agency",
        industry: "General",
        briefText: "Recovery test brief.",
        proposalContent: "",
        status: "proposal_drafting",
        generationStatus,
        tenderId,
        updatedAt,
      })
      .returning({ id: proposalsTable.id });
    await db
      .update(tendersTable)
      .set({ proposalId: proposal.id })
      .where(eq(tendersTable.id, tenderId));
    return proposal.id;
  }

  it("turns stale phased and legacy phase-less drafts into retry-ready failures", async () => {
    const staleAt = new Date(Date.now() - STALE_PROPOSAL_GENERATION_MS - 60_000);
    const phasedTenderId = await createTender("Recovery phased tender", "Recovery Test Agency");
    const phasedProposalId = await createProposal(phasedTenderId, "drafting", staleAt);
    const legacyTenderId = await createTender("Recovery legacy tender", "Recovery Test Agency");
    const legacyProposalId = await createProposal(legacyTenderId, null, staleAt);

    const count = await recoverStaleProposalGenerations();
    assert.ok(count >= 2, "both stale test proposals must be recovered");

    const [phasedProposal] = await db
      .select()
      .from(proposalsTable)
      .where(eq(proposalsTable.id, phasedProposalId));
    const [legacyProposal] = await db
      .select()
      .from(proposalsTable)
      .where(eq(proposalsTable.id, legacyProposalId));
    const [phasedTender] = await db
      .select()
      .from(tendersTable)
      .where(eq(tendersTable.id, phasedTenderId));
    const [legacyTender] = await db
      .select()
      .from(tendersTable)
      .where(eq(tendersTable.id, legacyTenderId));

    assert.equal(phasedProposal.generationStatus, "failed");
    assert.equal(phasedProposal.status, "draft");
    assert.match(phasedProposal.generationError ?? "", /during drafting/i);
    assert.equal(legacyProposal.generationStatus, "failed");
    assert.equal(legacyProposal.status, "draft");
    assert.match(legacyProposal.generationError ?? "", /phase could be recorded/i);
    assert.equal(phasedTender.status, "draft");
    assert.equal(phasedTender.proposalId, phasedProposalId);
    assert.equal(legacyTender.status, "draft");
    assert.equal(legacyTender.proposalId, legacyProposalId);
  });

  it("does not recover a fresh active generation", async () => {
    const tenderId = await createTender("Recovery fresh tender", "Recovery Test Agency");
    const proposalId = await createProposal(tenderId, "extracting", new Date());

    await recoverStaleProposalGenerations();

    const [proposal] = await db
      .select()
      .from(proposalsTable)
      .where(eq(proposalsTable.id, proposalId));
    const [tender] = await db
      .select()
      .from(tendersTable)
      .where(eq(tendersTable.id, tenderId));
    assert.equal(proposal.generationStatus, "extracting");
    assert.equal(proposal.status, "proposal_drafting");
    assert.equal(tender.status, "proposal_drafting");
  });

  it("prevents an expired generation attempt from overwriting a retry", async () => {
    const tenderId = await createTender("Recovery ownership tender", "Recovery Test Agency");
    const proposalId = await createProposal(tenderId, "drafting", new Date());
    const expiredAttemptId = `expired-${Date.now()}`;
    const retryAttemptId = `retry-${Date.now()}`;
    await db
      .update(proposalsTable)
      .set({ generationAttemptId: expiredAttemptId })
      .where(eq(proposalsTable.id, proposalId));

    let releaseAi!: () => void;
    const aiGate = new Promise<void>((resolve) => {
      releaseAi = resolve;
    });
    let markAiCalled!: () => void;
    const aiCalled = new Promise<void>((resolve) => {
      markAiCalled = resolve;
    });
    __setInvokeAISpy(async () => {
      markAiCalled();
      await aiGate;
      return {
        content: JSON.stringify({
          sections: [{ key: "executive_summary", content: "Stale worker content." }],
        }),
        model: "test",
      };
    });

    const staleWorker = generateProposalDraftAndPersist({
      tenderId,
      proposalId,
      briefText: "Old attempt brief.",
      strategyContext: "",
      generationAttemptId: expiredAttemptId,
    });
    await aiCalled;

    await db
      .update(proposalsTable)
      .set({
        generationAttemptId: retryAttemptId,
        generationStatus: "drafting",
        proposalContent: "Retry-owned content.",
      })
      .where(eq(proposalsTable.id, proposalId));
    releaseAi();

    await assert.rejects(
      staleWorker,
      (err: unknown) =>
        err instanceof Error &&
        (err as NodeJS.ErrnoException).code === "GENERATION_SUPERSEDED",
    );

    const [proposal] = await db
      .select()
      .from(proposalsTable)
      .where(eq(proposalsTable.id, proposalId));
    const sections = await db
      .select()
      .from(proposalSectionsTable)
      .where(eq(proposalSectionsTable.proposalId, proposalId));
    assert.equal(proposal.generationAttemptId, retryAttemptId);
    assert.equal(proposal.proposalContent, "Retry-owned content.");
    assert.equal(sections.length, 0, "the expired attempt must not replace retry sections");
  });

  it("prevents a stale failure handler from resetting a retry tender", async () => {
    const tenderId = await createTender("Recovery failure ownership tender", "Recovery Test Agency");
    const proposalId = await createProposal(tenderId, "drafting", new Date());
    const retryAttemptId = `retry-failure-${Date.now()}`;
    await db
      .update(proposalsTable)
      .set({
        generationAttemptId: retryAttemptId,
        generationStatus: "drafting",
        status: "proposal_drafting",
      })
      .where(eq(proposalsTable.id, proposalId));
    await db
      .update(tendersTable)
      .set({ proposalId, status: "proposal_drafting" })
      .where(eq(tendersTable.id, tenderId));

    const changed = await failOwnedProposalGeneration({
      proposalId,
      tenderId,
      generationAttemptId: "expired-attempt",
      generationError: "Old worker failed.",
    });

    const [proposal] = await db
      .select()
      .from(proposalsTable)
      .where(eq(proposalsTable.id, proposalId));
    const [tender] = await db
      .select()
      .from(tendersTable)
      .where(eq(tendersTable.id, tenderId));
    assert.equal(changed, false);
    assert.equal(proposal.generationAttemptId, retryAttemptId);
    assert.equal(proposal.generationStatus, "drafting");
    assert.equal(tender.status, "proposal_drafting");
    assert.equal(tender.proposalId, proposalId);
  });

  it("removes only rows matching both call-count fixture markers", async () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const fixtureTenderId = await createTender(`Call-Count Test Tender ${suffix}`, "Test Agency");
    const fixtureProposalId = await createProposal(fixtureTenderId, null, new Date());
    await db.insert(proposalSectionsTable).values({
      proposalId: fixtureProposalId,
      sectionKey: "executive_summary",
      title: "Executive Summary",
      content: "Fixture section.",
      status: "drafted",
      orderIndex: 0,
    });

    const preservedTenderId = await createTender(
      `Call-Count Test Tender preserved ${suffix}`,
      "Real Agency",
    );
    const preservedProposalId = await createProposal(preservedTenderId, "failed", new Date());

    const removed = await removeCallCountTestFixtures();
    assert.ok(removed >= 1, "the exact call-count fixture must be removed");

    const [removedTender] = await db
      .select({ id: tendersTable.id })
      .from(tendersTable)
      .where(eq(tendersTable.id, fixtureTenderId));
    const [removedProposal] = await db
      .select({ id: proposalsTable.id })
      .from(proposalsTable)
      .where(eq(proposalsTable.id, fixtureProposalId));
    const [preservedTender] = await db
      .select({ id: tendersTable.id })
      .from(tendersTable)
      .where(eq(tendersTable.id, preservedTenderId));
    const [preservedProposal] = await db
      .select({ id: proposalsTable.id })
      .from(proposalsTable)
      .where(eq(proposalsTable.id, preservedProposalId));

    assert.equal(removedTender, undefined);
    assert.equal(removedProposal, undefined);
    assert.equal(preservedTender?.id, preservedTenderId);
    assert.equal(preservedProposal?.id, preservedProposalId);
  });
});