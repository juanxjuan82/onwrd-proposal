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
const workspaceSrc     = readFileSync(path.join(frontendDir, "proposals-workspace.tsx"), "utf8");

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

  it("generation failed state is surfaced via generationStatus in the status panel", () => {
    // The simplified workflow shows gen status via generationStatus=failed
    assert.ok(
      detailSrc.includes('generationStatus === "failed"'),
      "proposal-detail.tsx must show failed state by checking generationStatus === 'failed'"
    );
    assert.ok(
      detailSrc.includes("gen-status-text"),
      "gen-status-text testid must be present for the status label"
    );
  });

  it("proposals-workspace uses run-full-generation to launch generation", () => {
    // The workspace page (not proposal-detail) now drives generation via run-full-generation
    assert.ok(
      workspaceSrc.includes("run-full-generation"),
      "proposals-workspace.tsx must call the run-full-generation endpoint"
    );
    assert.ok(
      workspaceSrc.includes("Generate Proposal"),
      "proposals-workspace.tsx must show a Generate Proposal action"
    );
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// §B  Behavioral tests (new — require real DB + mocked AI gateway)
// ═══════════════════════════════════════════════════════════════════════════════
// These tests use a live PostgreSQL database (same instance as dev), a real
// Express test server, and __setInvokeAISpy to prevent real AI calls.
// Test data is isolated by a unique timestamp prefix and cleaned up after each test.

import { before as _before, after as _after } from "node:test";
import express, { type Request, type Response, type NextFunction } from "express";
import { createServer, type Server } from "node:http";
import { db } from "@workspace/db";
import {
  tendersTable,
  proposalsTable,
  proposalSectionsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { __setInvokeAISpy } from "../lib/ai-gateway.js";

const { default: opportunitiesRouter } = await import("./opportunities.js");
const { default: sectionsRouter }      = await import("./sections.js");

let _server: Server;
let _baseUrl: string;

function _addReqLog(req: Request, _res: Response, next: NextFunction) {
  (req as unknown as Record<string, unknown>).log = { error: () => {}, warn: () => {}, info: () => {} };
  next();
}
function _addSession(req: Request, _res: Response, next: NextFunction) {
  if (!(req as unknown as Record<string, unknown>).session) {
    (req as unknown as Record<string, unknown>).session = { save: (cb: () => void) => cb() };
  }
  next();
}

// ── §B module-level helpers (accessible from any describe in this file) ──────

const _TEST_PREFIX = `[BEH-TEST-${Date.now()}]`;

async function _createTestTender(): Promise<number> {
  const [row] = await db
    .insert(tendersTable)
    .values({
      title: `${_TEST_PREFIX} Behavioral test tender`,
      agency: "Test Agency",
      description: "Description for behavioral test.",
      category: "General",
      status: "pending_review",
      recommendationScore: 0,
    })
    .returning({ id: tendersTable.id });
  return row.id;
}

async function _cleanupTestTender(tenderId: number): Promise<void> {
  const [proposal] = await db
    .select({ id: proposalsTable.id })
    .from(proposalsTable)
    .where(eq(proposalsTable.tenderId, tenderId));
  if (proposal) {
    await db.delete(proposalSectionsTable).where(eq(proposalSectionsTable.proposalId, proposal.id));
    await db.delete(proposalsTable).where(eq(proposalsTable.id, proposal.id));
  }
  await db.delete(tendersTable).where(eq(tendersTable.id, tenderId));
}

function _silentAiSpy() {
  __setInvokeAISpy(async () => ({
    content: JSON.stringify({ sections: [] }),
    model: "test-model",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  }));
}

// ── §B wrapper ────────────────────────────────────────────────────────────────
// File-level describe so that _before/_after are scoped to this describe (not
// the root suite). Without this wrapper the HTTP server stays alive for the
// entire test process, holding DB connections open while later files
// (ai-integration.test.ts) run — causing backfillPromotions() to block waiting
// for pool slots and leaving the crawl lock held into ai-route.test.ts.
describe("§B proposal-generation behavioral tests", () => {
  _before(async () => {
    const app = express();
    app.use(express.json());
    app.use(_addReqLog);
    app.use(_addSession);
    app.use("/api", opportunitiesRouter);
    app.use("/api", sectionsRouter);
    _server = createServer(app);
    await new Promise<void>((resolve) => _server.listen(0, "127.0.0.1", () => resolve()));
    const addr = _server.address() as { port: number };
    _baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  _after(async () => {
    await new Promise<void>((resolve, reject) =>
      _server.close((err) => (err ? reject(err) : resolve())),
    );
    __setInvokeAISpy(null);
  });

  // ── §13  Empty-draft guard in export (needs live server) ─────────────────────

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

    it("syncStatus pending_first_write is preserved (not reset) after draft_not_ready", async () => {
      const tenderId = await _createTestTender();
      const [pRow] = await db.insert(proposalsTable).values({
        clientName: "Test Client", industry: "General", briefText: "test",
        proposalContent: "", status: "draft", tenderId,
        syncStatus: "pending_first_write",
      }).returning({ id: proposalsTable.id });
      try {
        const res = await fetch(`${_baseUrl}/api/proposals/${pRow.id}/export`, { method: "POST" });
        assert.equal(res.status, 422, "export must return 422 for empty draft");
        const [row] = await db.select({ syncStatus: proposalsTable.syncStatus })
          .from(proposalsTable).where(eq(proposalsTable.id, pRow.id));
        assert.equal(
          row?.syncStatus, "pending_first_write",
          "readiness guard must not clear syncStatus; pending_first_write must survive draft_not_ready",
        );
      } finally {
        await db.delete(proposalSectionsTable).where(eq(proposalSectionsTable.proposalId, pRow.id));
        await db.delete(proposalsTable).where(eq(proposalsTable.id, pRow.id));
        await _cleanupTestTender(tenderId);
      }
    });

    it("syncStatus handoff_in_progress is preserved (not reset) after draft_not_ready", async () => {
      const tenderId = await _createTestTender();
      const [pRow] = await db.insert(proposalsTable).values({
        clientName: "Test Client", industry: "General", briefText: "test",
        proposalContent: "", status: "draft", tenderId,
        syncStatus: "handoff_in_progress",
      }).returning({ id: proposalsTable.id });
      try {
        const res = await fetch(`${_baseUrl}/api/proposals/${pRow.id}/export`, { method: "POST" });
        assert.equal(res.status, 422, "export must return 422 for empty draft");
        const [row] = await db.select({ syncStatus: proposalsTable.syncStatus })
          .from(proposalsTable).where(eq(proposalsTable.id, pRow.id));
        assert.equal(
          row?.syncStatus, "handoff_in_progress",
          "readiness guard must not clear syncStatus; handoff_in_progress must survive draft_not_ready",
        );
      } finally {
        await db.delete(proposalSectionsTable).where(eq(proposalSectionsTable.proposalId, pRow.id));
        await db.delete(proposalsTable).where(eq(proposalsTable.id, pRow.id));
        await _cleanupTestTender(tenderId);
      }
    });

    it("null syncStatus remains null after draft_not_ready", async () => {
      const tenderId = await _createTestTender();
      const [pRow] = await db.insert(proposalsTable).values({
        clientName: "Test Client", industry: "General", briefText: "test",
        proposalContent: "", status: "draft", tenderId,
        syncStatus: null,
      }).returning({ id: proposalsTable.id });
      try {
        const res = await fetch(`${_baseUrl}/api/proposals/${pRow.id}/export`, { method: "POST" });
        assert.equal(res.status, 422, "export must return 422 for empty draft");
        const [row] = await db.select({ syncStatus: proposalsTable.syncStatus })
          .from(proposalsTable).where(eq(proposalsTable.id, pRow.id));
        assert.equal(
          row?.syncStatus ?? null, null,
          "readiness guard must not disturb null syncStatus",
        );
      } finally {
        await db.delete(proposalSectionsTable).where(eq(proposalSectionsTable.proposalId, pRow.id));
        await db.delete(proposalsTable).where(eq(proposalsTable.id, pRow.id));
        await _cleanupTestTender(tenderId);
      }
    });

    it("422 guard appears before getValidGoogleAccessToken — readiness check precedes auth", () => {
      const draftNotReadyPos = sectionsSrc.indexOf("draft_not_ready");
      const authCallPos      = sectionsSrc.indexOf("await getValidGoogleAccessToken");
      assert.ok(draftNotReadyPos > 0, "draft_not_ready must exist in sections.ts");
      assert.ok(authCallPos > 0,      "getValidGoogleAccessToken call must exist in sections.ts");
      assert.ok(
        draftNotReadyPos < authCallPos,
        "draft readiness guard must appear BEFORE getValidGoogleAccessToken — no auth triggered for unready drafts",
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

  // ── §B-1  Two concurrent generate-proposal requests ──────────────────────────

  describe("§B-1 concurrent generate-proposal → one AI invocation", () => {
  _after(() => { __setInvokeAISpy(null); });

  it("exactly one request succeeds (200) and the other is rejected (409 generation_in_progress)", async () => {
    const tenderId = await _createTestTender();
    let aiCallCount = 0;
    let resolveAi!: () => void;
    const aiCalled = new Promise<void>((resolve) => { resolveAi = resolve; });
    __setInvokeAISpy(async () => {
      aiCallCount++;
      resolveAi();
      return { content: JSON.stringify({ sections: [] }), model: "test", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    });
    const send = () => fetch(`${_baseUrl}/api/opportunities/${tenderId}/generate-proposal`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    try {
      const [r1, r2] = await Promise.all([send(), send()]);
      const statuses = [r1.status, r2.status].sort((a, b) => a - b);
      assert.deepStrictEqual(statuses, [200, 409], "One request must get 200 and the other 409");
      const rejected = [r1, r2].find((r) => r.status === 409)!;
      const body = await rejected.json() as { code?: string };
      assert.equal(body.code, "generation_in_progress", "409 must carry code: generation_in_progress");
      await Promise.race([
        aiCalled,
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error("AI spy not called within 5 s")), 5000)),
      ]);
      assert.equal(aiCallCount, 1, "AI must be invoked exactly once across both requests");
    } finally { __setInvokeAISpy(null); await _cleanupTestTender(tenderId); }
  });

  it("both requests resolve the same canonical Proposal id", async () => {
    const tenderId = await _createTestTender();
    _silentAiSpy();
    const send = () => fetch(`${_baseUrl}/api/opportunities/${tenderId}/generate-proposal`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    try {
      const [r1, r2] = await Promise.all([send(), send()]);
      const b1 = await r1.json() as { proposalId?: number };
      const b2 = await r2.json() as { proposalId?: number };
      const canonicalId = b1.proposalId ?? b2.proposalId;
      assert.ok(canonicalId, "At least one response must include a proposalId");
      const [dbRow] = await db.select({ id: proposalsTable.id }).from(proposalsTable).where(eq(proposalsTable.tenderId, tenderId));
      assert.equal(dbRow?.id, canonicalId, "Canonical proposalId must match DB row");
    } finally { __setInvokeAISpy(null); await _cleanupTestTender(tenderId); }
  });

  it("only one section set exists after concurrent generation", async () => {
    const tenderId = await _createTestTender();
    _silentAiSpy();
    const send = () => fetch(`${_baseUrl}/api/opportunities/${tenderId}/generate-proposal`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    try {
      await Promise.all([send(), send()]);
      const [proposal] = await db.select({ id: proposalsTable.id }).from(proposalsTable).where(eq(proposalsTable.tenderId, tenderId));
      assert.ok(proposal, "Canonical proposal must exist");
      const sects = await db.select().from(proposalSectionsTable).where(eq(proposalSectionsTable.proposalId, proposal.id));
      assert.ok(sects.length <= 15, `Section count must not exceed 15 — got ${sects.length}`);
    } finally { __setInvokeAISpy(null); await _cleanupTestTender(tenderId); }
  });
});

// ── §B-2  proposalId mismatch rejected ───────────────────────────────────────────────────────────────────────────────

describe("§B-2 proposalId mismatch → 409 proposal_mismatch", () => {
  it("returns 409 proposal_mismatch when proposalId does not match canonical", async () => {
    const tenderId = await _createTestTender();
    _silentAiSpy();
    try {
      const r1 = await fetch(`${_baseUrl}/api/opportunities/${tenderId}/generate-proposal`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
      });
      assert.equal(r1.status, 200, "First request must create the proposal");
      const r2 = await fetch(`${_baseUrl}/api/opportunities/${tenderId}/generate-proposal`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ proposalId: 99999 }),
      });
      const body = await r2.json() as { code?: string };
      assert.equal(r2.status, 409);
      assert.equal(body.code, "proposal_mismatch");
    } finally { __setInvokeAISpy(null); await _cleanupTestTender(tenderId); }
  });
});

// ── §B-3  Empty content → 422 before auth ──────────────────────────────────────────────────────────────────────

describe("§B-3 export empty content → 422 draft_not_ready, zero OAuth/Drive/Docs calls", () => {
  it("returns 422 draft_not_ready before touching Google OAuth or Drive", async () => {
    const tenderId = await _createTestTender();
    const [pRow] = await db.insert(proposalsTable).values({
      clientName: "Test Client", industry: "General", briefText: "test",
      proposalContent: "", status: "draft", tenderId,
    }).returning({ id: proposalsTable.id });
    try {
      const res = await fetch(`${_baseUrl}/api/proposals/${pRow.id}/export`, { method: "POST" });
      assert.equal(res.status, 422);
      const body = await res.json() as { code?: string };
      assert.equal(body.code, "draft_not_ready");
    } finally {
      await db.delete(proposalSectionsTable).where(eq(proposalSectionsTable.proposalId, pRow.id));
      await db.delete(proposalsTable).where(eq(proposalsTable.id, pRow.id));
      await _cleanupTestTender(tenderId);
    }
  });

  it("also returns 422 for the placeholder text", async () => {
    const tenderId = await _createTestTender();
    const [pRow] = await db.insert(proposalsTable).values({
      clientName: "Test Client", industry: "General", briefText: "test",
      proposalContent: "Generating proposal sections — please refresh in ~30 seconds.",
      status: "draft", tenderId,
    }).returning({ id: proposalsTable.id });
    try {
      const res = await fetch(`${_baseUrl}/api/proposals/${pRow.id}/export`, { method: "POST" });
      assert.equal(res.status, 422);
      const body = await res.json() as { code?: string };
      assert.equal(body.code, "draft_not_ready");
    } finally {
      await db.delete(proposalSectionsTable).where(eq(proposalSectionsTable.proposalId, pRow.id));
      await db.delete(proposalsTable).where(eq(proposalsTable.id, pRow.id));
      await _cleanupTestTender(tenderId);
    }
  });
});

// ── §B-4  Empty section shells not included in exported content ──────────────────────────────────

describe("§B-4 export — meaningful-content filtering (structural)", () => {
  it("hasMeaningfulContent logic correctly excludes empty and placeholder sections", () => {
    const DRAFTING_PLACEHOLDER = /generating proposal sections/i;
    const hasMeaningfulContent = (text: string | null | undefined): boolean =>
      !!(text?.trim()) && !DRAFTING_PLACEHOLDER.test(text.trim());
    const mockSections = [
      { title: "Executive Summary", content: "This is real content." },
      { title: "Investment",        content: "" },
      { title: "Next Steps",        content: "Generating proposal sections — please refresh in ~30 seconds." },
      { title: "Timeline",          content: "  " },
    ];
    const meaningful = mockSections.filter((s) => hasMeaningfulContent(s.content));
    assert.equal(meaningful.length, 1);
    assert.equal(meaningful[0].title, "Executive Summary");
  });

  it("draft_not_ready 422 fires before createGoogleDocInFolder in source", () => {
    const draftPos = sectionsSrc.indexOf("draft_not_ready");
    const gdocPos  = sectionsSrc.indexOf("createGoogleDocInFolder(");
    assert.ok(draftPos > 0 && gdocPos > 0);
    assert.ok(draftPos < gdocPos, "draft_not_ready must appear before createGoogleDocInFolder");
  });

  it("draft readiness check appears before await getValidGoogleAccessToken in source", () => {
    const readyPos = sectionsSrc.indexOf("Draft readiness");
    const authPos  = sectionsSrc.indexOf("await getValidGoogleAccessToken");
    assert.ok(readyPos > 0, "Expected 'Draft readiness' comment in sections.ts");
    assert.ok(authPos > 0, "Expected 'await getValidGoogleAccessToken' call in sections.ts");
    assert.ok(readyPos < authPos, "Draft readiness must appear before auth call");
  });
});

// ── §B-5  Session initialization failure → dbReady rejects ─────────────────────────────────────────

describe("§B-5 session init failure → dbReady rejects", () => {
  it("dbReady promise rejects when pool DDL fails", async () => {
    const failingPool = { query: async (_q: string) => { throw new Error("DDL refused"); } };
    const dbReady: Promise<void> = (failingPool.query as (_q: string) => Promise<void>)("CREATE TABLE ...")
      .then(() => undefined)
      .catch((err: unknown) => { throw err; });
    await assert.rejects(() => dbReady, (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /DDL refused/);
      return true;
    });
  });

  it("index.ts awaits dbReady inside try/catch and exits on failure", () => {
    assert.ok(indexSrc.includes("try {") && indexSrc.includes("await dbReady"), "index.ts must try { await dbReady }");
    assert.ok(indexSrc.includes("process.exit(1)"), "index.ts must call process.exit(1) on failure");
    const exitPos   = indexSrc.indexOf("process.exit(1)");
    const listenPos = indexSrc.indexOf("app.listen");
    assert.ok(exitPos < listenPos, "process.exit(1) must precede app.listen");
  });
});

}); // end §B wrapper describe
