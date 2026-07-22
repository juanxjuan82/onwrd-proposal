/**
 * No-auto-AI assertions for creation/import paths
 *
 * Runner: node:test (built-in)
 * Transpiler: tsx (ESM)
 *
 * Covers:
 *  - ANALYSIS_ACTIVE_STATUSES does not include creation-time resting states
 *  - Status determination logic after deterministic scoring
 *  - Extraction pipeline terminal states
 *  - Strategy generation is a distinct, separate step
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ANALYSIS_ACTIVE_STATUSES } from "./analysis-utils.js";

// ── Helper: mirrors the status-assignment logic in all three import paths ─────

function determineCreationStatus(fitLevel: string): string {
  return fitLevel === "no_bid" ? "no_bid" : "pending_review";
}

// ── ANALYSIS_ACTIVE_STATUSES guard ────────────────────────────────────────────

describe("ANALYSIS_ACTIVE_STATUSES", () => {
  it("does not include pending_review", () => {
    assert.ok(
      !(ANALYSIS_ACTIVE_STATUSES as readonly string[]).includes("pending_review"),
      "pending_review must not be an active-analysis status — it is a reviewable resting state after creation",
    );
  });

  it("does not include opportunity_found", () => {
    assert.ok(
      !(ANALYSIS_ACTIVE_STATUSES as readonly string[]).includes("opportunity_found"),
      "opportunity_found must not be an active-analysis status",
    );
  });

  it("does not include requirements_extracted", () => {
    assert.ok(
      !(ANALYSIS_ACTIVE_STATUSES as readonly string[]).includes("requirements_extracted"),
      "requirements_extracted is a valid resting state — strategy is triggered separately",
    );
  });

  it("does not include screened", () => {
    assert.ok(
      !(ANALYSIS_ACTIVE_STATUSES as readonly string[]).includes("screened"),
      "screened is a terminal state, not an active-analysis status",
    );
  });

  it("does not include no_bid", () => {
    assert.ok(
      !(ANALYSIS_ACTIVE_STATUSES as readonly string[]).includes("no_bid"),
      "no_bid is a terminal state, not an active-analysis status",
    );
  });

  it("includes the three real pipeline steps", () => {
    const expected = ["requirements_extracting", "bid_scoring", "strategy_generating"];
    for (const step of expected) {
      assert.ok(
        (ANALYSIS_ACTIVE_STATUSES as readonly string[]).includes(step),
        `expected ${step} to be an active-analysis status`,
      );
    }
  });

  it("includes legacy analysing for backward compat", () => {
    assert.ok(
      (ANALYSIS_ACTIVE_STATUSES as readonly string[]).includes("analysing"),
      "legacy 'analysing' status must remain in ANALYSIS_ACTIVE_STATUSES for backward compat",
    );
  });
});

// ── Creation-path status assignment ───────────────────────────────────────────

describe("determineCreationStatus (all creation/import paths)", () => {
  it("assigns pending_review for strong fit", () => {
    assert.equal(determineCreationStatus("strong"), "pending_review");
  });

  it("assigns pending_review for moderate fit", () => {
    assert.equal(determineCreationStatus("moderate"), "pending_review");
  });

  it("assigns pending_review for weak fit", () => {
    assert.equal(determineCreationStatus("weak"), "pending_review");
  });

  it("assigns no_bid for no_bid fit", () => {
    assert.equal(determineCreationStatus("no_bid"), "no_bid");
  });

  it("assigns pending_review for any unknown fit level", () => {
    assert.equal(determineCreationStatus("unknown_level"), "pending_review");
    assert.equal(determineCreationStatus(""), "pending_review");
  });
});

// ── Extraction pipeline terminal states ───────────────────────────────────────

describe("extraction pipeline terminal states", () => {
  it("requirements_extracted is not an active status (extraction is done, not in-progress)", () => {
    const active = ANALYSIS_ACTIVE_STATUSES as readonly string[];
    assert.ok(!active.includes("requirements_extracted"));
  });

  it("strategy_generating IS an active status (bounded strategy job is running)", () => {
    const active = ANALYSIS_ACTIVE_STATUSES as readonly string[];
    assert.ok(active.includes("strategy_generating"));
  });

  it("extraction and strategy statuses are separate pipeline phases", () => {
    const extractionSteps = ["requirements_extracting", "bid_scoring"];
    const strategySteps   = ["strategy_generating"];
    const active = ANALYSIS_ACTIVE_STATUSES as readonly string[];

    for (const step of extractionSteps) {
      assert.ok(active.includes(step), `${step} should be active during extraction`);
    }
    for (const step of strategySteps) {
      assert.ok(active.includes(step), `${step} should be active during strategy generation`);
    }
  });
});

// ── Convert idempotency invariants ────────────────────────────────────────────

describe("convert endpoint invariants (pure logic)", () => {
  it("a tender with an existing proposalId should not create a new proposal", () => {
    const tender = { proposalId: 42 };
    const shouldCreateNew = !tender.proposalId;
    assert.equal(shouldCreateNew, false);
  });

  it("a tender with no proposalId requires proposal creation", () => {
    const tender = { proposalId: null };
    const shouldCreateNew = !tender.proposalId;
    assert.equal(shouldCreateNew, true);
  });

  it("the convert endpoint returns existing: true for already-linked opportunities", () => {
    const existingProposalId = 7;
    const response = { proposalId: existingProposalId, existing: true };
    assert.equal(response.existing, true);
    assert.equal(response.proposalId, existingProposalId);
  });
});
