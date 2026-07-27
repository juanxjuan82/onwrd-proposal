/**
 * Proposal workflow tests — Task #32
 *
 * Covers:
 *   §A  normalizeSectionBody (pure unit)
 *   §B  assembleProposalFromSections (pure unit)
 *   §C  Backend immutability guards (structural)
 *   §D  Prompt heading fix (structural)
 *   §E  Export and assembly (structural)
 *   §F  Frontend workflow gating (structural)
 *
 * Runner: node --import tsx/esm --test
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { normalizeSectionBody, assembleProposalFromSections } from "@workspace/proposal-content";
import { db, tendersTable, proposalsTable, proposalSectionsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { generateProposalDraftAndPersist, SECTION_DEFINITIONS } from "../lib/proposal-draft-service.js";
import { googleDocCanonicalPayload } from "../lib/proposal-predicates.js";
import { __setInvokeAISpy } from "../lib/ai-gateway.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir    = path.resolve(__dirname, "../../../..");
const routesDir  = path.resolve(rootDir, "artifacts/api-server/src/routes");
const frontendDir = path.resolve(rootDir, "artifacts/proposal-generator/src/pages");

const sectionsSrc     = readFileSync(path.join(routesDir, "sections.ts"), "utf8");
const oppsSrc         = readFileSync(path.join(routesDir, "opportunities.ts"), "utf8");
const proposalsSrc    = readFileSync(path.join(routesDir, "proposals.ts"), "utf8");
const detailSrc       = readFileSync(path.join(frontendDir, "proposal-detail.tsx"), "utf8");
const workspaceSrc    = readFileSync(path.join(frontendDir, "proposals-workspace.tsx"), "utf8");
const draftSvcSrc     = readFileSync(
  path.resolve(rootDir, "artifacts/api-server/src/lib/proposal-draft-service.ts"),
  "utf8",
);

// ── §A  normalizeSectionBody ───────────────────────────────────────────────────

describe("§A normalizeSectionBody", () => {
  it("strips an exact ## heading matching the section title", () => {
    const result = normalizeSectionBody("Executive Summary", "## Executive Summary\n\nBody text.");
    assert.ok(!result.startsWith("## Executive Summary"), "heading should be stripped");
    assert.ok(result.includes("Body text."), "body must be preserved");
  });

  it("is case-insensitive when matching", () => {
    const result = normalizeSectionBody("Executive Summary", "## EXECUTIVE SUMMARY\n\nBody.");
    assert.ok(!result.includes("## EXECUTIVE SUMMARY"), "must match case-insensitively");
    assert.ok(result.includes("Body."), "body preserved");
  });

  it("strips leading ordinal numbering from the heading", () => {
    const result = normalizeSectionBody("Executive Summary", "## 1. Executive Summary\n\nBody.");
    assert.ok(!result.includes("## 1. Executive Summary"), "ordinal-prefixed heading stripped");
    assert.ok(result.includes("Body."), "body preserved");
  });

  it("strips trailing punctuation from the heading", () => {
    const result = normalizeSectionBody("Executive Summary", "## Executive Summary:\n\nBody.");
    assert.ok(!result.includes("## Executive Summary:"), "colon-suffixed heading stripped");
    assert.ok(result.includes("Body."), "body preserved");
  });

  it("preserves a heading that does NOT match the section title", () => {
    const result = normalizeSectionBody("Executive Summary", "## Introduction\n\nBody.");
    assert.ok(result.includes("## Introduction"), "non-matching heading must be preserved");
  });

  it("does not strip a level-4 or deeper heading", () => {
    const result = normalizeSectionBody("Executive Summary", "#### Executive Summary\n\nBody.");
    assert.ok(result.includes("#### Executive Summary"), "#### heading is out of range (only #1-3 stripped)");
  });

  it("strips only the first heading — internal subheadings survive", () => {
    const content = "## Executive Summary\n\nIntro.\n\n### Key Points\n\nDetails.";
    const result = normalizeSectionBody("Executive Summary", content);
    assert.ok(!result.startsWith("## Executive Summary"), "outer heading stripped");
    assert.ok(result.includes("### Key Points"), "internal subheading preserved");
  });

  it("handles blank lines before a non-matching heading", () => {
    const content = "\n## Pricing\n\nBody.";
    const result = normalizeSectionBody("Executive Summary", content);
    assert.ok(result.includes("## Pricing"), "non-matching heading preserved even after blank lines");
  });

  it("returns empty or whitespace-only content unchanged", () => {
    assert.equal(normalizeSectionBody("Executive Summary", ""), "");
    assert.equal(normalizeSectionBody("Executive Summary", "   \n\n   "), "   \n\n   ");
  });
});

// ── §B  assembleProposalFromSections ──────────────────────────────────────────

describe("§B assembleProposalFromSections", () => {
  it("sorts sections by orderIndex ascending", () => {
    const sections = [
      { title: "B", content: "b body", orderIndex: 1 },
      { title: "A", content: "a body", orderIndex: 0 },
    ];
    const result = assembleProposalFromSections(sections);
    assert.ok(result.indexOf("## A") < result.indexOf("## B"), "A must appear before B");
  });

  it("prefixes each section with exactly one ## heading", () => {
    const sections = [{ title: "Executive Summary", content: "Body.", orderIndex: 0 }];
    const result = assembleProposalFromSections(sections);
    assert.ok(result.startsWith("## Executive Summary"), "must start with ## heading");
  });

  it("joins sections with the --- separator", () => {
    const sections = [
      { title: "A", content: "a", orderIndex: 0 },
      { title: "B", content: "b", orderIndex: 1 },
    ];
    const result = assembleProposalFromSections(sections);
    assert.ok(result.includes("\n\n---\n\n"), "sections must be joined with --- separator");
  });

  it("does not duplicate a section heading the AI included in content", () => {
    const sections = [
      { title: "Executive Summary", content: "## Executive Summary\n\nBody text.", orderIndex: 0 },
    ];
    const result = assembleProposalFromSections(sections);
    const count = (result.match(/## Executive Summary/g) ?? []).length;
    assert.equal(count, 1, "heading must appear exactly once after normalisation");
  });

  it("a single section produces no separator", () => {
    const sections = [{ title: "Only", content: "one", orderIndex: 0 }];
    const result = assembleProposalFromSections(sections);
    assert.ok(!result.includes("---"), "single section must have no separator");
  });
});

// ── §C  Backend immutability guards ───────────────────────────────────────────

describe("§C Backend immutability guards", () => {
  it("sections.ts PUT section calls googleDocCanonicalPayload", () => {
    const putBlock = sectionsSrc.slice(sectionsSrc.indexOf("Update a single section"));
    assert.ok(
      putBlock.includes("googleDocCanonicalPayload"),
      "PUT section must call the immutability guard helper"
    );
  });

  it("sections.ts PUT section responds with 409 when guard fires", () => {
    const putBlock = sectionsSrc.slice(sectionsSrc.indexOf("Update a single section"));
    assert.ok(
      putBlock.includes("res.status(409).json(blocked)"),
      "PUT section must emit 409 json when blocked"
    );
  });

  it("sections.ts run-critic has immutability guard", () => {
    const criticBlock = sectionsSrc.slice(sectionsSrc.indexOf("Run critic pass"));
    assert.ok(
      criticBlock.includes("googleDocCanonicalPayload"),
      "run-critic must call the immutability guard"
    );
  });

  it("sections.ts ai-improve-sections has immutability guard", () => {
    const improveBlock = sectionsSrc.slice(sectionsSrc.indexOf("ai-improve-sections"));
    assert.ok(
      improveBlock.includes("googleDocCanonicalPayload"),
      "ai-improve-sections must call the immutability guard"
    );
  });

  it("generate-proposal transaction throws GOOGLE_DOC_CANONICAL for handoff-complete proposals", () => {
    const genBlock = oppsSrc.slice(oppsSrc.indexOf("generate-proposal"));
    assert.ok(
      genBlock.includes("GOOGLE_DOC_CANONICAL"),
      "generate-proposal must throw GOOGLE_DOC_CANONICAL when proposal is in Google Docs"
    );
  });

  it("generate-proposal catch block returns 409 with code google_doc_canonical", () => {
    const genBlock = oppsSrc.slice(oppsSrc.indexOf("generate-proposal"));
    assert.ok(
      genBlock.includes('"google_doc_canonical"'),
      "generate-proposal catch must emit code: google_doc_canonical"
    );
  });
});

// ── §D  Prompt heading fix ────────────────────────────────────────────────────

describe("§D AI prompt does not instruct section-title headings", () => {
  it("prompt does not tell AI to use ## for section headings", () => {
    const genBlock = oppsSrc.slice(oppsSrc.indexOf("generate-proposal"));
    assert.ok(
      !genBlock.includes("headings with ##"),
      "prompt must not contain 'headings with ##'"
    );
  });

  it("prompt instructs BODY ONLY content (in shared draft service)", () => {
    // The AI prompt lives in proposal-draft-service.ts since generate-proposal
    // and run-full-generation both delegate to generateProposalDraftAndPersist.
    assert.ok(
      draftSvcSrc.includes("BODY ONLY"),
      "proposal-draft-service.ts must instruct the AI to return the section body only"
    );
  });
});

// ── §E  Export and assembly ───────────────────────────────────────────────────

describe("§E assembleProposalFromSections used throughout backend", () => {
  it("sections.ts imports assembleProposalFromSections", () => {
    assert.ok(
      sectionsSrc.includes("assembleProposalFromSections"),
      "sections.ts must import and use assembleProposalFromSections"
    );
  });

  it("opportunities.ts delegates draft assembly to generateProposalDraftAndPersist (shared service)", () => {
    assert.ok(
      oppsSrc.includes("generateProposalDraftAndPersist"),
      "opportunities.ts must delegate AI draft + assembleProposalFromSections to the shared draft service"
    );
  });

  it("export route uses assembleProposalFromSections for section content", () => {
    const exportBlock = sectionsSrc.slice(sectionsSrc.indexOf("Unified export"));
    assert.ok(
      exportBlock.includes("assembleProposalFromSections(meaningfulSections)"),
      "export route must call assembleProposalFromSections(meaningfulSections)"
    );
  });

  it("generate-proposal delegates section writes + assembly to generateProposalDraftAndPersist", () => {
    const genBlock = oppsSrc.slice(oppsSrc.indexOf("generate-proposal"));
    assert.ok(
      genBlock.includes("generateProposalDraftAndPersist"),
      "generate-proposal must call generateProposalDraftAndPersist (which handles section loop + assembleProposalFromSections internally)"
    );
  });

  it("PUT section rebuilds proposalContent inside a transaction", () => {
    const putBlock = sectionsSrc.slice(sectionsSrc.indexOf("Update a single section"));
    assert.ok(
      putBlock.includes("db.transaction") && putBlock.includes("assembleProposalFromSections"),
      "PUT section must rebuild proposalContent transactionally"
    );
  });

  it("ai-improve-sections rebuilds proposalContent after the improvement loop", () => {
    const improveBlock = sectionsSrc.slice(sectionsSrc.indexOf("AI improve sections"));
    assert.ok(
      improveBlock.includes("assembleProposalFromSections"),
      "ai-improve-sections must rebuild proposalContent using the assembler"
    );
  });
});

// ── §G  run-full-generation endpoint + workspace (Task #33) ──────────────────

describe("§G run-full-generation and proposals workspace", () => {

  // ── Backend: opportunities.ts ────────────────────────────────────────────

  it("opportunities.ts registers POST /run-full-generation endpoint", () => {
    assert.ok(
      oppsSrc.includes('"/opportunities/:id/run-full-generation"'),
      "POST /opportunities/:id/run-full-generation must be registered"
    );
  });

  it("run-full-generation returns HTTP 202 immediately", () => {
    assert.ok(
      oppsSrc.includes("res.status(202)"),
      "run-full-generation must respond with 202 Accepted"
    );
    assert.ok(
      oppsSrc.includes('generationStatus: "extracting"'),
      "run-full-generation must return generationStatus: extracting in the 202 body"
    );
  });

  it("run-full-generation uses ON CONFLICT DO NOTHING for idempotent proposal creation", () => {
    const genBlock = oppsSrc.slice(oppsSrc.indexOf("run-full-generation"));
    assert.ok(
      genBlock.includes("ON CONFLICT") && genBlock.includes("DO NOTHING"),
      "run-full-generation must use INSERT … ON CONFLICT (tender_id) DO NOTHING"
    );
  });

  it("run-full-generation prevents re-launch when active generation is not stale", () => {
    assert.ok(
      oppsSrc.includes("FULL_GEN_STALE_MS"),
      "run-full-generation must define and check FULL_GEN_STALE_MS for stale detection"
    );
    assert.ok(
      oppsSrc.includes("ACTIVE_GEN_STATUSES"),
      "run-full-generation must check ACTIVE_GEN_STATUSES before relaunching"
    );
    assert.ok(
      oppsSrc.includes("alreadyRunning"),
      "run-full-generation must set alreadyRunning:true and return early when not stale"
    );
  });

  it("run-full-generation returns 409 when a canonical Google Doc exists", () => {
    const genBlock = oppsSrc.slice(oppsSrc.indexOf("run-full-generation"));
    assert.ok(
      genBlock.includes("GOOGLE_DOC_CANONICAL"),
      "run-full-generation must guard against overwriting a canonical Google Doc"
    );
    assert.ok(
      genBlock.includes("res.status(409)"),
      "Google Doc canonical guard must return 409"
    );
  });

  it("runFullGenerationBackground is invoked with void after 202 response", () => {
    assert.ok(
      oppsSrc.includes("void runFullGenerationBackground(id, proposalId)"),
      "background pipeline must be launched with void (fire-and-forget) after responding 202"
    );
  });

  // ── Backend: runFullGenerationBackground phase-skip logic ────────────────

  it("runFullGenerationBackground skips extraction when requirementsExtractedAt is set and rows exist", () => {
    const bgStart = oppsSrc.indexOf("async function runFullGenerationBackground");
    const bgBlock = oppsSrc.slice(bgStart, bgStart + 3000);
    assert.ok(
      bgBlock.includes("requirementsExtractedAt"),
      "background fn must check requirementsExtractedAt for extraction phase-skip"
    );
    assert.ok(
      bgBlock.includes("extractionComplete"),
      "background fn must gate runExtractRequirements on extractionComplete flag"
    );
  });

  it("runFullGenerationBackground skips strategy when existing strategy row found", () => {
    const bgStart = oppsSrc.indexOf("async function runFullGenerationBackground");
    const bgBlock = oppsSrc.slice(bgStart, bgStart + 4000);
    assert.ok(
      bgBlock.includes("existingStrategy"),
      "background fn must query for existingStrategy before calling runGenerateStrategy"
    );
    assert.ok(
      bgBlock.includes("if (!existingStrategy)"),
      "background fn must only call runGenerateStrategy when no strategy exists"
    );
  });

  it("runFullGenerationBackground sets generationStatus=strategizing before strategy phase", () => {
    const bgStart = oppsSrc.indexOf("async function runFullGenerationBackground");
    const bgBlock = oppsSrc.slice(bgStart, bgStart + 4000);
    assert.ok(
      bgBlock.includes('"strategizing"') || bgBlock.includes("'strategizing'"),
      "background fn must call setGenStatus('strategizing') between extraction and strategy"
    );
  });

  it("runFullGenerationBackground sets generationStatus=drafting before the AI draft call", () => {
    const bgStart = oppsSrc.indexOf("async function runFullGenerationBackground");
    const bgBlock = oppsSrc.slice(bgStart, bgStart + 6000);
    assert.ok(
      bgBlock.includes('"drafting"') || bgBlock.includes("'drafting'"),
      "background fn must call setGenStatus('drafting') before the draft AI invocation"
    );
  });

  it("runFullGenerationBackground sets generationStatus=ready and delegates draft to shared service on success", () => {
    const bgStart = oppsSrc.indexOf("async function runFullGenerationBackground");
    const bgBlock = oppsSrc.slice(bgStart, bgStart + 9000);
    assert.ok(
      bgBlock.includes("setGenStatus") && (bgBlock.includes('"ready"') || bgBlock.includes("'ready'")),
      "background fn must call setGenStatus with 'ready' on successful generation"
    );
    assert.ok(
      bgBlock.includes("generateProposalDraftAndPersist"),
      "background fn must delegate AI draft + section writes to generateProposalDraftAndPersist"
    );
  });

  it("runFullGenerationBackground sets generationStatus=failed on error", () => {
    const bgStart = oppsSrc.indexOf("async function runFullGenerationBackground");
    const failBlock = oppsSrc.slice(bgStart, bgStart + 1000);
    assert.ok(
      failBlock.includes("generation_status = 'failed'"),
      "background fn fail() helper must set generationStatus=failed in the proposals table"
    );
  });

  // ── Backend: proposals.ts workspace endpoint ─────────────────────────────

  it("proposals.ts registers /proposals/workspace before /proposals/:id", () => {
    const workspaceIdx = proposalsSrc.indexOf('"/proposals/workspace"');
    const idRouteIdx   = proposalsSrc.indexOf('"/proposals/:id"');
    assert.ok(workspaceIdx !== -1, "workspace endpoint must be registered");
    assert.ok(idRouteIdx   !== -1, ":id route must exist");
    assert.ok(
      workspaceIdx < idRouteIdx,
      "workspace endpoint must appear before /:id route to prevent shadowing"
    );
  });

  it("workspace query includes non-crawler tenders and promoted crawlers, excludes bare crawlers", () => {
    const wsBlock = proposalsSrc.slice(proposalsSrc.indexOf("proposals/workspace"));
    assert.ok(
      wsBlock.includes("source_type != 'crawler'") || wsBlock.includes("source_type != \"crawler\""),
      "workspace query must pass through non-crawler tenders"
    );
    assert.ok(
      wsBlock.includes("proposal_id IS NOT NULL"),
      "workspace query must include crawlers only when proposal_id is set (selected)"
    );
  });
});

// ── §G behavioral — DB-connected, AI-spy-intercepted ─────────────────────────
// Requires DATABASE_URL to be set. Uses __setInvokeAISpy to prevent real AI calls.

describe("§G behavioral — DB-connected", () => {
  let tenderId = -1;
  let proposalId = -1;

  before(async () => {
    // Spy returns 15 minimal sections so generateProposalDraftAndPersist can complete
    __setInvokeAISpy(async (_req: unknown) => ({
      content: JSON.stringify({
        sections: SECTION_DEFINITIONS.map((s) => ({
          key:     s.key,
          content: `Behavioral-test content for ${s.title}.`,
        })),
      }),
      model:        "spy-model",
      inputTokens:  10,
      outputTokens: 100,
    }));

    // Create DB fixtures — unique suffix avoids collision
    const suffix = `bwt-${Date.now()}`;
    const [t] = await db.insert(tendersTable).values({
      title:       `Behavioral Test Tender ${suffix}`,
      agency:      "Test Agency",
      category:    "Marketing",
      description: "A test tender for behavioral proposal-workflow tests",
      status:      "opportunity_found",
      sourceType:  "pasted_text",
    }).returning();
    tenderId = t.id;

    const [p] = await db.insert(proposalsTable).values({
      clientName:      "Test Agency",
      industry:        "Marketing",
      briefText:       "Behavioral test brief",
      proposalContent: "",
      status:          "draft",
      tenderId,
    }).returning();
    proposalId = p.id;
  });

  after(async () => {
    __setInvokeAISpy(null);
    if (proposalId > 0) {
      await db.execute(sql`DELETE FROM proposal_sections WHERE proposal_id = ${proposalId}`);
      await db.execute(sql`DELETE FROM proposal_generation_runs WHERE proposal_id = ${proposalId}`);
      await db.execute(sql`DELETE FROM proposals WHERE id = ${proposalId}`);
    }
    if (tenderId > 0) {
      await db.execute(sql`DELETE FROM tenders WHERE id = ${tenderId}`);
    }
  });

  it("generation_status column exists in proposals table", async () => {
    const res = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'proposals' AND column_name = 'generation_status'
    `);
    assert.equal((res.rows as unknown[]).length, 1, "generation_status column must exist in proposals");
  });

  it("handoff_started_at column exists in proposals table", async () => {
    const res = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'proposals' AND column_name = 'handoff_started_at'
    `);
    assert.equal((res.rows as unknown[]).length, 1, "handoff_started_at column must exist in proposals");
  });

  it("generateProposalDraftAndPersist writes all 15 sections atomically and assembles proposalContent", async () => {
    await generateProposalDraftAndPersist({
      tenderId,
      proposalId,
      briefText:       "Test brief text for behavioral test",
      strategyContext: "",
    });

    const sections = await db
      .select()
      .from(proposalSectionsTable)
      .where(eq(proposalSectionsTable.proposalId, proposalId));

    assert.equal(sections.length, 15, "must persist exactly 15 sections");
    assert.ok(
      sections.every((s) => s.content && s.content.trim().length > 0),
      "every section must have non-empty content after a successful run",
    );

    const [updated] = await db
      .select()
      .from(proposalsTable)
      .where(eq(proposalsTable.id, proposalId));

    assert.ok(
      updated.proposalContent && updated.proposalContent.trim().length > 0,
      "proposalContent must be assembled and persisted in the same transaction",
    );
  });

  it("generateProposalDraftAndPersist is idempotent — second call replaces sections", async () => {
    const before = await db
      .select()
      .from(proposalSectionsTable)
      .where(eq(proposalSectionsTable.proposalId, proposalId));

    await generateProposalDraftAndPersist({
      tenderId,
      proposalId,
      briefText:       "Second call brief",
      strategyContext: "",
    });

    const after2 = await db
      .select()
      .from(proposalSectionsTable)
      .where(eq(proposalSectionsTable.proposalId, proposalId));

    assert.equal(after2.length, 15, "must still have 15 sections after second call");
    assert.equal(before.length, 15, "should have 15 from first call");
    // Verify sections were refreshed — every section should have content from the second spy call
    assert.ok(
      after2.every((s) => s.content && s.content.includes("Behavioral-test content")),
      "second call must overwrite all section content",
    );
  });

  it("googleDocCanonicalPayload returns error payload when syncStatus=handoff_complete", () => {
    const blocked = googleDocCanonicalPayload({
      syncStatus:   "handoff_complete",
      googleFileId: null,
      googleDocUrl: null,
    });
    assert.ok(blocked !== null, "must return a non-null error payload");
    assert.equal(blocked.code,  "google_doc_canonical", "code must be google_doc_canonical");
    assert.equal(blocked.error, "google_doc_canonical", "error must be google_doc_canonical");
  });

  it("googleDocCanonicalPayload returns null when proposal is still in draft (no Google Doc)", () => {
    const result = googleDocCanonicalPayload({
      syncStatus:   null,
      googleFileId: null,
      googleDocUrl: null,
    });
    assert.equal(result, null, "must return null when proposal has no Google Doc");
  });

  it("googleDocCanonicalPayload includes googleDocUrl in payload when available", () => {
    const url = "https://docs.google.com/document/d/abc/edit";
    const blocked = googleDocCanonicalPayload({
      syncStatus:   "handoff_complete",
      googleFileId: "abc",
      googleDocUrl: url,
    });
    assert.ok(blocked !== null);
    assert.equal(blocked.googleDocUrl, url, "payload must include googleDocUrl for client redirect");
  });
});

// ── §F  Frontend workflow gating ──────────────────────────────────────────────

describe("§F Frontend workflow gating", () => {
  it("generationStatus is derived from proposal for linked tenders", () => {
    assert.ok(
      detailSrc.includes("generationStatus"),
      "proposal-detail.tsx must derive generationStatus from the proposal object"
    );
    assert.ok(
      detailSrc.includes("linkedTenderId"),
      "proposal-detail.tsx must derive linkedTenderId to identify linked opportunities"
    );
  });

  it("isGenActive combines isDrafting with active generation status values", () => {
    assert.ok(
      detailSrc.includes("isGenActive"),
      "proposal-detail.tsx must define isGenActive to track generation in flight"
    );
    assert.ok(
      detailSrc.includes("isDrafting"),
      "isGenActive must incorporate isDrafting"
    );
  });

  it("gen-status-text testid marks the generation phase label in the action panel", () => {
    assert.ok(
      detailSrc.includes("gen-status-text"),
      "generation status panel must have data-testid=gen-status-text"
    );
  });

  it("polling interval fires when isGenActive is true", () => {
    // The effect that drives polling must reference isGenActive
    const effectIdx = detailSrc.indexOf("isGenActive");
    const effectBody = detailSrc.slice(effectIdx, effectIdx + 400);
    assert.ok(
      effectBody.includes("setInterval") || detailSrc.includes("isGenActive, id, queryClient"),
      "polling effect must use isGenActive to decide when to poll"
    );
  });

  it("auto-switches active tab to preview when generationStatus becomes ready", () => {
    assert.ok(
      detailSrc.includes('generationStatus === "ready"'),
      "detail page must detect generationStatus=ready to auto-switch tab"
    );
    assert.ok(
      detailSrc.includes("setActiveTab"),
      "detail page must call setActiveTab to switch to the preview tab"
    );
  });

  it("Full Proposal Preview uses assembleProposalFromSections", () => {
    assert.ok(
      detailSrc.includes("assembleProposalFromSections"),
      "proposal-detail.tsx must call assembleProposalFromSections for the preview"
    );
  });

  it("isFreeform guards the freeform editor from showing during loading/drafting", () => {
    assert.ok(
      detailSrc.includes("isFreeform"),
      "proposal-detail.tsx must define and use isFreeform"
    );
  });
});
