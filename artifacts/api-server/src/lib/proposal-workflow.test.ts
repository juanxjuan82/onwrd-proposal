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
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { normalizeSectionBody, assembleProposalFromSections } from "@workspace/proposal-content";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir    = path.resolve(__dirname, "../../../..");
const routesDir  = path.resolve(rootDir, "artifacts/api-server/src/routes");
const frontendDir = path.resolve(rootDir, "artifacts/proposal-generator/src/pages");

const sectionsSrc    = readFileSync(path.join(routesDir, "sections.ts"), "utf8");
const oppsSrc        = readFileSync(path.join(routesDir, "opportunities.ts"), "utf8");
const proposalsSrc   = readFileSync(path.join(routesDir, "proposals.ts"), "utf8");
const detailSrc      = readFileSync(path.join(frontendDir, "proposal-detail.tsx"), "utf8");
const workspaceSrc   = readFileSync(path.join(frontendDir, "proposals-workspace.tsx"), "utf8");

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

  it("prompt instructs BODY ONLY content", () => {
    const genBlock = oppsSrc.slice(oppsSrc.indexOf("generate-proposal"));
    assert.ok(
      genBlock.includes("BODY ONLY"),
      "prompt must instruct the AI to return the section body only"
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

  it("opportunities.ts imports assembleProposalFromSections", () => {
    assert.ok(
      oppsSrc.includes("assembleProposalFromSections"),
      "opportunities.ts must import and use assembleProposalFromSections"
    );
  });

  it("export route uses assembleProposalFromSections for section content", () => {
    const exportBlock = sectionsSrc.slice(sectionsSrc.indexOf("Unified export"));
    assert.ok(
      exportBlock.includes("assembleProposalFromSections(meaningfulSections)"),
      "export route must call assembleProposalFromSections(meaningfulSections)"
    );
  });

  it("generate-proposal uses assembleProposalFromSections after writing sections", () => {
    const genBlock = oppsSrc.slice(oppsSrc.indexOf("generate-proposal"));
    assert.ok(
      genBlock.includes("assembleProposalFromSections(updatedSections)"),
      "generate-proposal must call assembleProposalFromSections after the section loop"
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

  it("runFullGenerationBackground sets generationStatus=ready and proposal_content on success", () => {
    const bgStart = oppsSrc.indexOf("async function runFullGenerationBackground");
    const bgBlock = oppsSrc.slice(bgStart, bgStart + 9000);
    assert.ok(
      bgBlock.includes("'ready'"),
      "background fn must set generationStatus=ready on successful generation"
    );
    assert.ok(
      bgBlock.includes("proposal_content"),
      "background fn must write the assembled proposal_content on success"
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
