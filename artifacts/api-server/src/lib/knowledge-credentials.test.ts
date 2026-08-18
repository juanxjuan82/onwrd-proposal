/**
 * Task #64 — Prevent proposals from citing invented clients.
 *
 * Covers:
 *  §KC-1 unit — extractOrgCandidates / scanUnverifiedCredentials
 *  §KC-2 unit — buildKnowledgeBlock (empty set → placeholder instruction)
 *  §KC-3 DB — getApprovedKnowledge excludes isApproved:false documents
 *  §KC-4 behavioral — draft pipeline: allowlist in prompt, fabricated names
 *         flagged (run 3×), placeholder path clean, retrievedKnowledgeIds
 *  §KC-5 route — export & approve-for-export blocked while
 *         unverifiedCredentials is non-empty; section edit clears the flag
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { db, knowledgeDocumentsTable, proposalsTable, proposalSectionsTable, proposalGenerationRunsTable, tendersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  getApprovedKnowledge,
  buildKnowledgeBlock,
  extractOrgCandidates,
  scanUnverifiedCredentials,
} from "./approved-knowledge.js";
import { generateProposalDraftAndPersist } from "./proposal-draft-service.js";
import { __setInvokeAISpy, type AIResult } from "./ai-gateway.js";

const APPROVED_TITLES = [
  "Telecommunications Industry",
  "Securities Commission of The Bahamas",
  "Templeton Religion Trust",
];

describe("knowledge credentials (task #64)", () => {
  // ── §KC-1 unit: candidate extraction + allowlist scan ────────────────────
  describe("§KC-1 scanUnverifiedCredentials", () => {
    it("flags an organisation not on the allowlist (World Central Kitchen)", () => {
      const content =
        "ONWRD delivered a content strategy for World Central Kitchen in The Bahamas, " +
        "similar to our work for the Securities Commission of The Bahamas.";
      const unverified = scanUnverifiedCredentials(content, APPROVED_TITLES);
      assert.ok(
        unverified.some((n) => n.includes("World Central Kitchen")),
        `expected World Central Kitchen flagged, got: ${JSON.stringify(unverified)}`,
      );
      assert.ok(
        !unverified.some((n) => n.includes("Securities Commission")),
        "approved title must not be flagged",
      );
    });

    it("does not flag exact approved titles, ONWRD, regional terms, or the tender agency", () => {
      const content =
        "Our engagement Telecommunications Industry shows ONWRD's depth across the Caribbean. " +
        "We understand the Ministry of Tourism's goals in Nassau and Grand Bahama.";
      const unverified = scanUnverifiedCredentials(content, APPROVED_TITLES, ["Ministry of Tourism"]);
      assert.deepEqual(unverified, []);
    });

    it("flags a paraphrased/renamed client (drifted name not matching any title)", () => {
      // "Caribbean Telecommunications Provider" is a drift from the approved
      // title "Telecommunications Industry" — it must be flagged.
      const content = "We rebranded the Caribbean Telecommunications Provider app suite.";
      const unverified = scanUnverifiedCredentials(content, APPROVED_TITLES);
      assert.ok(unverified.some((n) => n.includes("Telecommunications Provider")));
    });

    it("flags one-word and acronym invented clients (Acme, Disney, UNICEF)", () => {
      const content =
        "We delivered campaigns for Acme and partnered with Disney. " +
        "ONWRD also supported UNICEF on regional outreach.";
      const unverified = scanUnverifiedCredentials(content, APPROVED_TITLES);
      for (const name of ["Acme", "Disney", "UNICEF"]) {
        assert.ok(unverified.includes(name), `expected ${name} flagged, got: ${JSON.stringify(unverified)}`);
      }
    });

    it("flags one-word invented clients at sentence, heading, and list-item starts", () => {
      const content = [
        "Disney was an ONWRD client for three seasons.",
        "## Initech",
        "A full digital transformation engagement.",
        "- Globex: island-wide brand awareness campaign",
      ].join("\n");
      const unverified = scanUnverifiedCredentials(content, APPROVED_TITLES);
      for (const name of ["Disney", "Initech", "Globex"]) {
        assert.ok(unverified.includes(name), `expected ${name} flagged, got: ${JSON.stringify(unverified)}`);
      }
    });

    it("does not flag legitimate title-cased service phrases in an approved case-study description", () => {
      const unverified = scanUnverifiedCredentials(
        "ONWRD delivered Marketing Strategy, Brand Visual Strategy and Design for Templeton Religion Trust, " +
          "including Social Media Management and a Website Redesign.",
        APPROVED_TITLES,
      );
      assert.deepEqual(unverified, [], `service phrases must not hard-block export, got: ${JSON.stringify(unverified)}`);
    });

    it("does not flag mid-sentence business acronyms or months", () => {
      const unverified = scanUnverifiedCredentials(
        "We track ROI and KPIs quarterly, with SEO reviews each January and a final RFP response.",
        APPROVED_TITLES,
      );
      assert.deepEqual(unverified, []);
    });

    it("only case_study titles are valid credentials — capability titles do not sanitise a citation", () => {
      // Callers pass only case-study titles as the allowlist; a capability/blog
      // title used as a purported client must therefore be flagged.
      const caseStudyOnlyAllowlist = ["Telecommunications Industry"];
      const unverified = scanUnverifiedCredentials(
        "Our past client Brand Strategy Trends saw strong results.",
        caseStudyOnlyAllowlist,
      );
      assert.ok(unverified.some((n) => n.includes("Brand Strategy Trends")));
    });

    it("extractOrgCandidates skips generic sentence-lead capitalisation", () => {
      const candidates = extractOrgCandidates(
        "Our Approach is simple. This Project will succeed. We Deliver results.",
      );
      assert.deepEqual(candidates, []);
    });
  });

  // ── §KC-2 unit: knowledge block ───────────────────────────────────────────
  describe("§KC-2 buildKnowledgeBlock", () => {
    it("empty knowledge set instructs the [NEEDS ONWRD INPUT] placeholder and bans client names", () => {
      const block = buildKnowledgeBlock([]);
      assert.ok(block.includes("[NEEDS ONWRD INPUT: relevant case study]"));
      assert.ok(/MUST NOT name any past client/i.test(block));
    });

    it("non-empty set lists exact titles and the exact-title citation rule", () => {
      const block = buildKnowledgeBlock([
        { id: 1, title: "Telecommunications Industry", content: "Telecom work.", docType: "case_study" },
        { id: 2, title: "Blog: Some Capability Post", content: "Blog.", docType: "capability" },
      ]);
      assert.ok(block.includes('"Telecommunications Industry"'));
      assert.ok(block.includes('"Blog: Some Capability Post"'));
      assert.ok(/exact titles verbatim/i.test(block));
      assert.ok(block.includes("[NEEDS ONWRD INPUT: relevant case study]"));
    });
  });

  // ── §KC-3 DB: isApproved=false exclusion ─────────────────────────────────
  describe("§KC-3 getApprovedKnowledge", () => {
    it("never returns an isApproved:false document", async () => {
      const marker = `KC-UNAPPROVED-${Date.now()}`;
      const [doc] = await db
        .insert(knowledgeDocumentsTable)
        .values({ title: marker, content: "secret unapproved", docType: "case_study", isApproved: false })
        .returning({ id: knowledgeDocumentsTable.id });
      try {
        const approved = await getApprovedKnowledge();
        assert.ok(!approved.some((d) => d.title === marker), "unapproved doc leaked into allowlist");
        const block = buildKnowledgeBlock(approved);
        assert.ok(!block.includes(marker), "unapproved doc leaked into prompt block");
      } finally {
        await db.delete(knowledgeDocumentsTable).where(eq(knowledgeDocumentsTable.id, doc.id));
      }
    });
  });

  // ── §KC-4 behavioral: draft pipeline ─────────────────────────────────────
  describe("§KC-4 draft pipeline credential validation", () => {
    async function makeFixture() {
      const [t] = await db.insert(tendersTable).values({
        title: `[KC-TEST-${Date.now()}] Tourism campaign RFP`,
        agency: "Ministry of Tourism",
        description: "Marketing campaign services.",
        category: "Marketing",
        status: "screened",
        recommendationScore: 0,
      }).returning({ id: tendersTable.id });
      const [p] = await db.insert(proposalsTable).values({
        clientName: "Ministry of Tourism",
        industry: "Marketing",
        briefText: "brief",
        proposalContent: "",
        status: "draft",
        tenderId: t.id,
      }).returning({ id: proposalsTable.id });
      return { tenderId: t.id, proposalId: p.id };
    }

    async function cleanup(tenderId: number, proposalId: number) {
      await db.delete(proposalSectionsTable).where(eq(proposalSectionsTable.proposalId, proposalId));
      await db.delete(proposalGenerationRunsTable).where(eq(proposalGenerationRunsTable.proposalId, proposalId));
      await db.delete(proposalsTable).where(eq(proposalsTable.id, proposalId));
      await db.delete(tendersTable).where(eq(tendersTable.id, tenderId));
    }

    function spyReturning(caseStudiesContent: string, capturePrompt?: (sys: string) => void) {
      return async (params: { messages: Array<{ role: string; content: string }> }): Promise<AIResult> => {
        const sys = params.messages.find((m) => m.role === "system")?.content ?? "";
        capturePrompt?.(sys);
        return {
          content: JSON.stringify({ sections: [{ key: "case_studies", content: caseStudiesContent }] }),
          model: "test-model",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      };
    }

    it("prompt contains the live approved allowlist (not the removed static constant)", async () => {
      const { tenderId, proposalId } = await makeFixture();
      let sysPrompt = "";
      __setInvokeAISpy(spyReturning("[NEEDS ONWRD INPUT: relevant case study]", (s) => { sysPrompt = s; }) as never);
      try {
        await generateProposalDraftAndPersist({ tenderId, proposalId, briefText: "brief", strategyContext: "" });
        assert.ok(sysPrompt.includes("ALLOWLIST"), "system prompt must contain the allowlist block");
        const approved = await getApprovedKnowledge();
        if (approved.length > 0) {
          assert.ok(sysPrompt.includes(`"${approved[0].title}"`), "allowlist must carry exact DB titles");
        }
        // The old static constant's fabrication vector must be gone:
        assert.ok(!sysPrompt.includes("onwrdadvisors.com/work"), "static ONWRD_CASE_STUDIES constant must not be used");
      } finally {
        __setInvokeAISpy(null);
        await cleanup(tenderId, proposalId);
      }
    });

    it("fabricated client in the credentials section → unverifiedCredentials + reviewRequired (3 runs)", async () => {
      for (let run = 0; run < 3; run++) {
        const { tenderId, proposalId } = await makeFixture();
        __setInvokeAISpy(spyReturning(
          "ONWRD previously delivered a strategy for World Central Kitchen and the Securities Commission of The Bahamas.",
        ) as never);
        try {
          const result = await generateProposalDraftAndPersist({ tenderId, proposalId, briefText: "brief", strategyContext: "" });
          assert.ok(
            result.unverifiedCredentials.some((n) => n.includes("World Central Kitchen")),
            `run ${run}: fabricated client must be flagged`,
          );
          assert.equal(result.reviewRequired, true, `run ${run}: reviewRequired must be true`);
          const [row] = await db
            .select({ reviewRequired: proposalsTable.reviewRequired, unverifiedCredentials: proposalsTable.unverifiedCredentials })
            .from(proposalsTable).where(eq(proposalsTable.id, proposalId));
          assert.equal(row.reviewRequired, true, `run ${run}: persisted reviewRequired`);
          assert.ok(row.unverifiedCredentials.some((n) => n.includes("World Central Kitchen")), `run ${run}: persisted unverifiedCredentials`);
        } finally {
          __setInvokeAISpy(null);
          await cleanup(tenderId, proposalId);
        }
      }
    });

    it("placeholder output ([NEEDS ONWRD INPUT]) is clean — no unverified credentials, no fabricated names", async () => {
      const { tenderId, proposalId } = await makeFixture();
      __setInvokeAISpy(spyReturning("[NEEDS ONWRD INPUT: relevant case study]") as never);
      try {
        const result = await generateProposalDraftAndPersist({ tenderId, proposalId, briefText: "brief", strategyContext: "" });
        assert.deepEqual(result.unverifiedCredentials, []);
        assert.equal(result.hasBlockedSections, true, "placeholder must mark the section blocked");
      } finally {
        __setInvokeAISpy(null);
        await cleanup(tenderId, proposalId);
      }
    });

    it("generation run records the retrieved knowledge ids", async () => {
      const { tenderId, proposalId } = await makeFixture();
      __setInvokeAISpy(spyReturning("[NEEDS ONWRD INPUT: relevant case study]") as never);
      try {
        await generateProposalDraftAndPersist({ tenderId, proposalId, briefText: "brief", strategyContext: "" });
        const [run] = await db
          .select({ ids: proposalGenerationRunsTable.retrievedKnowledgeIds })
          .from(proposalGenerationRunsTable)
          .where(eq(proposalGenerationRunsTable.proposalId, proposalId));
        const ids = JSON.parse(run.ids ?? "[]") as number[];
        const approvedCount = (await getApprovedKnowledge()).length;
        assert.equal(ids.length, approvedCount, "run must record every retrieved approved doc id");
      } finally {
        __setInvokeAISpy(null);
        await cleanup(tenderId, proposalId);
      }
    });
  });

  // ── §KC-5 route-level: share/export gates + section-edit clearing ────────
  describe("§KC-5 export gates", () => {
    let server: import("node:http").Server;
    let baseUrl = "";
    before(async () => {
      const express = (await import("express")).default;
      const { createServer } = await import("node:http");
      const { default: sectionsRouter } = await import("../routes/sections.js");
      const { default: proposalsRouter } = await import("../routes/proposals.js");
      const app = express();
      app.use(express.json());
      app.use((req: any, _res: any, next: any) => {
        req.log = { error: () => {}, warn: () => {}, info: () => {} };
        req.session = {};
        next();
      });
      app.use("/api", sectionsRouter);
      app.use("/api", proposalsRouter);
      server = createServer(app);
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    });
    after(async () => {
      await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
    });

    async function makeFlaggedProposal() {
      const [p] = await db.insert(proposalsTable).values({
        clientName: "Ministry of Tourism",
        industry: "Marketing",
        briefText: "brief",
        proposalContent: "# Proposal\n## Case Studies and Credentials\nONWRD delivered a campaign for World Central Kitchen.",
        unverifiedCredentials: ["World Central Kitchen"],
        reviewRequired: true,
        status: "ready_for_review",
      }).returning({ id: proposalsTable.id });
      return p.id;
    }

    it("POST /proposals/:id/export → 422 unverified_credentials while flag is set", async () => {
      const id = await makeFlaggedProposal();
      try {
        const res = await fetch(`${baseUrl}/api/proposals/${id}/export`, { method: "POST" });
        assert.equal(res.status, 422);
        const body = await res.json() as { code?: string; unverifiedCredentials?: string[] };
        assert.equal(body.code, "unverified_credentials");
        assert.deepEqual(body.unverifiedCredentials, ["World Central Kitchen"]);
      } finally {
        await db.delete(proposalsTable).where(eq(proposalsTable.id, id));
      }
    });

    it("export is 422-blocked even for handoff_complete / legacy-linked proposals", async () => {
      const [p] = await db.insert(proposalsTable).values({
        clientName: "Ministry of Tourism",
        industry: "Marketing",
        briefText: "brief",
        proposalContent: "# Proposal\n## Case Studies and Credentials\nONWRD delivered a campaign for World Central Kitchen.",
        unverifiedCredentials: ["World Central Kitchen"],
        reviewRequired: true,
        status: "exported",
        syncStatus: "handoff_complete",
        googleFileId: "fake-file-id",
        googleDocUrl: "https://docs.google.com/document/d/fake-file-id/edit",
      }).returning({ id: proposalsTable.id });
      try {
        const res = await fetch(`${baseUrl}/api/proposals/${p.id}/export`, { method: "POST" });
        assert.equal(res.status, 422, "completed proposals must still be hard-blocked, not handed a doc link");
        const body = await res.json() as { code?: string };
        assert.equal(body.code, "unverified_credentials");
      } finally {
        await db.delete(proposalsTable).where(eq(proposalsTable.id, p.id));
      }
    });

    it("POST /proposals/:id/approve-for-export → 422 even with overrideReason (hard block)", async () => {
      const id = await makeFlaggedProposal();
      try {
        const res = await fetch(`${baseUrl}/api/proposals/${id}/approve-for-export`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ overrideReason: "just ship it" }),
        });
        assert.equal(res.status, 422);
        const body = await res.json() as { code?: string };
        assert.equal(body.code, "unverified_credentials");
      } finally {
        await db.delete(proposalsTable).where(eq(proposalsTable.id, id));
      }
    });

    it("whole-document create (parse-brief save path) with invented client → export blocked; clean update clears it", async () => {
      const doc = (creds: string) => [
        "# Proposal for Ministry of Tourism",
        "## Our Approach",
        "We deliver integrated campaigns.",
        "## Case Studies and Credentials",
        creds,
        "## Investment",
        "Pricing to be confirmed.",
      ].join("\n");

      // Create via POST /proposals with an invented client in the case-studies section
      const createRes = await fetch(`${baseUrl}/api/proposals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName: "Ministry of Tourism",
          industry: "Marketing",
          briefText: "brief",
          proposalContent: doc("ONWRD previously delivered a rebrand for Globex Corporation."),
        }),
      });
      assert.equal(createRes.status, 201);
      const created = await createRes.json() as { id: number; unverifiedCredentials: string[]; reviewRequired: boolean };
      try {
        assert.ok(created.unverifiedCredentials.some((n) => n.includes("Globex")), "invented client must be flagged on create");
        assert.equal(created.reviewRequired, true);

        // Export must be blocked
        const exportRes = await fetch(`${baseUrl}/api/proposals/${created.id}/export`, { method: "POST" });
        assert.equal(exportRes.status, 422);
        assert.equal(((await exportRes.json()) as { code?: string }).code, "unverified_credentials");

        // Whole-document PUT replacing the invented client with an approved title clears the block
        const approved = await getApprovedKnowledge();
        const approvedTitle = approved.find((d) => d.docType === "case_study")?.title;
        assert.ok(approvedTitle, "live DB must have at least one approved case study");
        const putRes = await fetch(`${baseUrl}/api/proposals/${created.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ proposalContent: doc(`Our engagement "${approvedTitle}" is directly relevant.`) }),
        });
        assert.equal(putRes.status, 200);
        const updated = await putRes.json() as { unverifiedCredentials: string[] };
        assert.deepEqual(updated.unverifiedCredentials, [], "clean whole-document edit must clear the flag");

        // And a PUT that re-introduces an invented client re-blocks
        const badPut = await fetch(`${baseUrl}/api/proposals/${created.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ proposalContent: doc("Recent work for Initech and UNICEF.") }),
        });
        assert.equal(badPut.status, 200);
        const reflagged = await badPut.json() as { unverifiedCredentials: string[]; reviewRequired: boolean };
        assert.ok(reflagged.unverifiedCredentials.includes("Initech"));
        assert.ok(reflagged.unverifiedCredentials.includes("UNICEF"));
        assert.equal(reflagged.reviewRequired, true);
      } finally {
        await db.delete(proposalsTable).where(eq(proposalsTable.id, created.id));
      }
    });

    it("invented clients named only in Case Studies sub-headings are still caught (multi-word + acronym)", async () => {
      const content = [
        "# Proposal for Ministry of Tourism",
        "## Our Approach",
        "We deliver integrated campaigns.",
        "## Case Studies and Credentials",
        "### World Central Kitchen",
        "A multi-island food relief campaign.",
        "### UNICEF",
        "Regional youth outreach programme.",
        "## Investment",
        "Pricing to be confirmed.",
      ].join("\n");
      const createRes = await fetch(`${baseUrl}/api/proposals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName: "Ministry of Tourism",
          industry: "Marketing",
          briefText: "brief",
          proposalContent: content,
        }),
      });
      assert.equal(createRes.status, 201);
      const created = await createRes.json() as { id: number; unverifiedCredentials: string[] };
      try {
        assert.ok(
          created.unverifiedCredentials.some((n) => n.includes("World Central Kitchen")),
          `heading-named multi-word client must be flagged, got: ${JSON.stringify(created.unverifiedCredentials)}`,
        );
        assert.ok(created.unverifiedCredentials.includes("UNICEF"), "heading-named acronym client must be flagged");
        const exportRes = await fetch(`${baseUrl}/api/proposals/${created.id}/export`, { method: "POST" });
        assert.equal(exportRes.status, 422);
      } finally {
        await db.delete(proposalsTable).where(eq(proposalsTable.id, created.id));
      }
    });

    it("unapproving a cited knowledge doc re-blocks export live — even for a completed proposal", async () => {
      // Own approved case study we can safely revoke
      const marker = `Marquee Island Client ${Date.now()}`;
      const [doc] = await db
        .insert(knowledgeDocumentsTable)
        .values({ title: marker, content: "Case study body.", docType: "case_study", isApproved: true })
        .returning({ id: knowledgeDocumentsTable.id });
      // Clean proposal citing it (empty persisted flag), already handed off
      const [p] = await db.insert(proposalsTable).values({
        clientName: "Ministry of Tourism",
        industry: "Marketing",
        briefText: "brief",
        proposalContent: `# Proposal\n## Case Studies and Credentials\nOur engagement ${marker} delivered strong results.`,
        unverifiedCredentials: [],
        reviewRequired: false,
        status: "exported",
        syncStatus: "handoff_complete",
        googleFileId: "fake-file-id",
        googleDocUrl: "https://docs.google.com/document/d/fake-file-id/edit",
      }).returning({ id: proposalsTable.id });
      try {
        // While approved: completed path returns the doc link
        const okRes = await fetch(`${baseUrl}/api/proposals/${p.id}/export`, { method: "POST" });
        assert.equal(okRes.status, 200, "approved citation must not block the completed path");

        // Revoke approval → both endpoints must hard-block despite the stale empty flag
        await db.update(knowledgeDocumentsTable)
          .set({ isApproved: false })
          .where(eq(knowledgeDocumentsTable.id, doc.id));

        const exportRes = await fetch(`${baseUrl}/api/proposals/${p.id}/export`, { method: "POST" });
        assert.equal(exportRes.status, 422, "unapproved citation must block export even when handoff_complete");
        assert.equal(((await exportRes.json()) as { code?: string }).code, "unverified_credentials");

        const approveRes = await fetch(`${baseUrl}/api/proposals/${p.id}/approve-for-export`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        assert.equal(approveRes.status, 422, "unapproved citation must block approve-for-export");

        // The live rescan persists the recomputed flag
        const [row] = await db
          .select({ unverifiedCredentials: proposalsTable.unverifiedCredentials, reviewRequired: proposalsTable.reviewRequired })
          .from(proposalsTable).where(eq(proposalsTable.id, p.id));
        assert.ok(row.unverifiedCredentials.length > 0, "rescan must persist the recomputed flag");
        assert.equal(row.reviewRequired, true);
      } finally {
        await db.delete(proposalsTable).where(eq(proposalsTable.id, p.id));
        await db.delete(knowledgeDocumentsTable).where(eq(knowledgeDocumentsTable.id, doc.id));
      }
    });

    it("editing the case_studies section to cite only approved titles clears the flag", async () => {
      const approved = await getApprovedKnowledge();
      const approvedTitle = approved.find((d) => d.docType === "case_study")?.title ?? approved[0]?.title;
      assert.ok(approvedTitle, "live DB must have at least one approved doc for this test");
      const id = await makeFlaggedProposal();
      const [section] = await db.insert(proposalSectionsTable).values({
        proposalId: id,
        sectionKey: "case_studies",
        title: "Case Studies and Credentials",
        content: "ONWRD worked with World Central Kitchen.",
        status: "drafted",
        orderIndex: 0,
      }).returning({ id: proposalSectionsTable.id });
      try {
        const res = await fetch(`${baseUrl}/api/proposals/${id}/sections/${section.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: `Our engagement "${approvedTitle}" is directly relevant.` }),
        });
        assert.equal(res.status, 200);
        const [row] = await db
          .select({ unverifiedCredentials: proposalsTable.unverifiedCredentials, reviewRequired: proposalsTable.reviewRequired })
          .from(proposalsTable).where(eq(proposalsTable.id, id));
        assert.deepEqual(row.unverifiedCredentials, [], "clean edit must clear unverifiedCredentials");
      } finally {
        await db.delete(proposalSectionsTable).where(eq(proposalSectionsTable.proposalId, id));
        await db.delete(proposalsTable).where(eq(proposalsTable.id, id));
      }
    });
  });
});
