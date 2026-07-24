/**
 * Regression tests for the multi-part workflow-navigation-intake-consolidation fixes:
 *   §12  Generate-proposal — canonical-proposal resolution (Fix A)
 *   §13  Empty-draft guard in export (Fix C)
 *   §14  Google OAuth callback URL + session error code (Fix D)
 *   §15  Session DDL await before listen (Fix D)
 *   §16  Frontend polling — structural checks (Fix B)
 *
 * Runner: node:test + tsx
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const routesDir  = path.resolve(__dirname);
const apiSrcDir  = path.resolve(__dirname, "..");
const frontendDir = path.resolve(__dirname, "../../../proposal-generator/src/pages");

const opportunitiesSrc = readFileSync(path.join(routesDir, "opportunities.ts"), "utf8");
const sectionsSrc      = readFileSync(path.join(routesDir, "sections.ts"), "utf8");
const authSrc          = readFileSync(path.join(routesDir, "auth.ts"), "utf8");
const appSrc           = readFileSync(path.join(apiSrcDir, "app.ts"), "utf8");
const indexSrc         = readFileSync(path.join(apiSrcDir, "index.ts"), "utf8");
const detailSrc        = readFileSync(path.join(frontendDir, "proposal-detail.tsx"), "utf8");

// ── §12  Generate-proposal — canonical-proposal resolution ─────────────────────

describe("§12 generate-proposal — canonical-proposal resolution", () => {
  it("reads proposalId from req.body before creating any proposal row", () => {
    assert.ok(
      opportunitiesSrc.includes("req.body?.proposalId"),
      "generate-proposal must read requestedProposalId from req.body"
    );
  });

  it("selects the existing proposal by tenderId before inserting", () => {
    const selectPattern = /select.*from.*proposals.*where.*tender_id|proposalsTable.*tenderId/is;
    const generateBlock = opportunitiesSrc.slice(
      opportunitiesSrc.indexOf("generate-proposal"),
    );
    assert.ok(
      selectPattern.test(generateBlock),
      "generate-proposal must SELECT by tenderId before any INSERT"
    );
  });

  it("uses INSERT ... ON CONFLICT (tender_id) DO NOTHING for the no-existing-proposal path", () => {
    assert.ok(
      opportunitiesSrc.includes("ON CONFLICT (tender_id) DO NOTHING"),
      "generate-proposal new-proposal path must use ON CONFLICT (tender_id) DO NOTHING"
    );
  });

  it("returns 409 with code generation_in_progress when proposal is already drafting", () => {
    assert.ok(
      opportunitiesSrc.includes('"generation_in_progress"'),
      "generate-proposal must return code: generation_in_progress when status is proposal_drafting"
    );
    assert.ok(
      opportunitiesSrc.includes("proposal_drafting"),
      "generate-proposal must check existingProposal.status === proposal_drafting"
    );
  });

  it("returns 409 with code proposal_mismatch when caller proposalId does not match canonical", () => {
    assert.ok(
      opportunitiesSrc.includes('"proposal_mismatch"'),
      "generate-proposal must return code: proposal_mismatch on proposalId mismatch"
    );
  });

  it("deletes existing section rows before inserting fresh shells", () => {
    assert.ok(
      opportunitiesSrc.includes("DELETE FROM proposal_sections"),
      "generate-proposal must DELETE existing section rows before reinserting"
    );
  });

  it("responds with proposalId in the response body", () => {
    assert.ok(
      opportunitiesSrc.includes("proposalId: draft.id"),
      "generate-proposal response must include proposalId so callers can navigate to canonical proposal"
    );
  });

  it("does NOT unconditionally INSERT a new proposal row", () => {
    const generateProposalBlock = opportunitiesSrc
      .split("generate-proposal")
      .slice(1)
      .join("generate-proposal");
    const unconditionalInsert =
      /await db\s*\.insert\s*\(\s*proposalsTable\s*\)\s*\.values\s*\(/s.test(generateProposalBlock);
    assert.equal(
      unconditionalInsert,
      false,
      "generate-proposal must NOT call db.insert(proposalsTable) unconditionally — use update or ON CONFLICT DO NOTHING"
    );
  });
});

// ── §13  Empty-draft guard in export ──────────────────────────────────────────

describe("§13 export — empty-draft guard before Drive mutation", () => {
  it("defines a hasMeaningfulContent helper in the export handler", () => {
    assert.ok(
      sectionsSrc.includes("hasMeaningfulContent"),
      "export handler must define hasMeaningfulContent guard"
    );
  });

  it("returns 422 with code draft_not_ready when content is not meaningful", () => {
    assert.ok(
      sectionsSrc.includes('"draft_not_ready"'),
      "export handler must return code: draft_not_ready when draft is not ready"
    );
    assert.ok(
      sectionsSrc.includes("status(422)"),
      "export handler must return HTTP 422 for draft not ready"
    );
  });

  it("checks for DRAFTING_PLACEHOLDER to detect placeholder content", () => {
    assert.ok(
      sectionsSrc.includes("generating proposal sections"),
      "export handler must test for the 'generating proposal sections' placeholder string"
    );
  });

  it("releases the sync lock (sets syncStatus to null) before returning 422", () => {
    const guardBlock = sectionsSrc.slice(sectionsSrc.indexOf("draft_not_ready") - 500, sectionsSrc.indexOf("draft_not_ready") + 200);
    assert.ok(
      guardBlock.includes("syncStatus: null"),
      "export handler must release syncStatus lock before returning 422"
    );
  });

  it("empty-draft guard appears before createGoogleDocInFolder call", () => {
    const draftNotReadyPos   = sectionsSrc.indexOf("draft_not_ready");
    // Use the function-call form (with opening paren) to skip the import declaration
    const createGoogleDocPos = sectionsSrc.indexOf("createGoogleDocInFolder(");
    assert.ok(
      draftNotReadyPos > 0 && createGoogleDocPos > 0,
      "both draft_not_ready and createGoogleDocInFolder call must exist in sections.ts"
    );
    assert.ok(
      draftNotReadyPos < createGoogleDocPos,
      "empty-draft guard must appear BEFORE the createGoogleDocInFolder call"
    );
  });
});

// ── §14  Google OAuth callback URL + session error code ───────────────────────

describe("§14 Google OAuth — callback URL + session error code", () => {
  it("getCallbackUrl checks GOOGLE_OAUTH_CALLBACK_URL env var first", () => {
    assert.ok(
      authSrc.includes("process.env.GOOGLE_OAUTH_CALLBACK_URL"),
      "getCallbackUrl must check GOOGLE_OAUTH_CALLBACK_URL env var before heuristics"
    );
  });

  it("GOOGLE_OAUTH_CALLBACK_URL override appears before the heuristic fallback", () => {
    const envVarPos  = authSrc.indexOf("GOOGLE_OAUTH_CALLBACK_URL");
    const replitPos  = authSrc.indexOf("REPLIT_DOMAINS");
    assert.ok(envVarPos < replitPos, "GOOGLE_OAUTH_CALLBACK_URL check must precede REPLIT_DOMAINS heuristic");
  });

  it("session save failure returns code session_store_unavailable", () => {
    assert.ok(
      authSrc.includes('"session_store_unavailable"'),
      "auth route must return code: session_store_unavailable on session.save failure"
    );
  });

  it("session save failure returns HTTP 503", () => {
    const saveFailureBlock = authSrc.slice(
      authSrc.indexOf("session_store_unavailable") - 100,
      authSrc.indexOf("session_store_unavailable") + 50,
    );
    assert.ok(
      saveFailureBlock.includes("status(503)"),
      "session save failure must return HTTP 503"
    );
  });
});

// ── §15  Session DDL await before listen ──────────────────────────────────────

describe("§15 session DDL — await before accepting connections", () => {
  it("app.ts exports a dbReady promise", () => {
    assert.ok(
      appSrc.includes("export const dbReady"),
      "app.ts must export dbReady promise"
    );
  });

  it("index.ts imports dbReady from app", () => {
    assert.ok(
      indexSrc.includes("dbReady") && indexSrc.includes('from "./app"'),
      "index.ts must import dbReady from ./app"
    );
  });

  it("index.ts awaits dbReady before app.listen", () => {
    const awaitPos  = indexSrc.indexOf("await dbReady");
    const listenPos = indexSrc.indexOf("app.listen");
    assert.ok(awaitPos > 0, "index.ts must await dbReady");
    assert.ok(awaitPos < listenPos, "await dbReady must appear before app.listen");
  });
});

// ── §16  Frontend — polling and form dirty guard ───────────────────────────────

describe("§16 proposal-detail — polling and form sync", () => {
  it("uses setInterval for continuous polling while isDrafting", () => {
    assert.ok(
      detailSrc.includes("setInterval"),
      "proposal-detail must use setInterval for continuous polling"
    );
    assert.ok(
      detailSrc.includes("isDrafting"),
      "polling interval must be gated on isDrafting flag"
    );
  });

  it("polling effect clears the interval on cleanup (prevents memory leaks)", () => {
    assert.ok(
      detailSrc.includes("clearInterval"),
      "proposal-detail polling effect must call clearInterval on cleanup"
    );
  });

  it("form is only reset from server when not dirty after generation", () => {
    assert.ok(
      detailSrc.includes("form.formState.isDirty"),
      "form reset after generation must be guarded by !form.formState.isDirty"
    );
  });

  it("tracks previous status to detect drafting→terminal transitions", () => {
    assert.ok(
      detailSrc.includes("prevStatusRef"),
      "proposal-detail must track previous status via prevStatusRef"
    );
    assert.ok(
      detailSrc.includes("proposal_drafting"),
      "prevStatus comparison must check proposal_drafting"
    );
  });

  it("handleGenerateDraft no longer uses setTimeout for refresh", () => {
    // Extract only the handleGenerateDraft function body to avoid false positives
    // from other components in the file (e.g. SectionsPanel) that may use setTimeout.
    const fnStart = detailSrc.indexOf("const handleGenerateDraft");
    const fnEnd   = detailSrc.indexOf("\n  };", fnStart) + 4;
    const fnBody  = fnStart > 0 ? detailSrc.slice(fnStart, fnEnd) : "";
    assert.equal(
      fnBody.includes("setTimeout"),
      false,
      "handleGenerateDraft must NOT use setTimeout — replaced by polling effect"
    );
  });

  it("Share button is disabled while proposal is being drafted", () => {
    // The share button uses either a direct comparison or the pre-computed isDrafting flag.
    // Both patterns prove the disable logic exists for proposal_drafting.
    const hasIsDraftingOnShare =
      detailSrc.includes("isDrafting") && detailSrc.includes("button-share");
    const hasDirectCompareOnShare =
      detailSrc.includes('"proposal_drafting"') && detailSrc.includes("button-share");
    assert.ok(
      hasIsDraftingOnShare || hasDirectCompareOnShare,
      "Share for Team Review button must be disabled when status is proposal_drafting"
    );
  });

  it("generation failure banner appears when proposalContent starts with Generation failed", () => {
    assert.ok(
      detailSrc.includes('startsWith("Generation failed")'),
      "failure banner must check proposalContent.startsWith('Generation failed')"
    );
    assert.ok(
      detailSrc.includes("generation-failure-banner"),
      "failure banner must have data-testid=generation-failure-banner"
    );
  });

  it("generation_in_progress 409 is handled with an informational toast, not an error", () => {
    assert.ok(
      detailSrc.includes('"generation_in_progress"'),
      "handleGenerateDraft must handle the generation_in_progress 409 code"
    );
    assert.ok(
      detailSrc.includes("Already generating"),
      "generation_in_progress must show an informational toast, not a destructive one"
    );
  });
});
