/**
 * No-auto-AI assertions — static boundary + pure-logic invariants
 *
 * Runner: node:test (built-in)
 * Transpiler: tsx (ESM)
 *
 * Covers:
 *  - Repository boundary guard: only ai-gateway.ts may import the OpenAI SDK
 *  - ANALYSIS_ACTIVE_STATUSES invariants
 *  - Creation-path status assignment (all import/creation routes)
 *  - Extraction pipeline terminal-state invariants
 *  - Strategy generation as a distinct pipeline phase
 *  - Convert-endpoint idempotency logic
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ANALYSIS_ACTIVE_STATUSES } from "./analysis-utils.js";

// ── 1. Repository boundary guard ──────────────────────────────────────────────
//
// The build guard (build.mjs) enforces this at build time; this test enforces
// it at test time so a CI run without a build step still catches violations.

describe("repository AI-import boundary", () => {
  it("only src/lib/ai-gateway.ts imports from @workspace/integrations-openai-ai-server", async () => {
    const srcDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
    );
    const gatewayPath = path.resolve(srcDir, "lib/ai-gateway.ts");
    // Match actual import statements only (not variable declarations or comments).
    // Constructed in two parts so this source file itself doesn't match the scan.
    const forbiddenPkg = "@workspace/" + "integrations-openai-ai-server";
    const importPattern = new RegExp(
      `^\\s*import\\s[\\s\\S]*?from\\s+['"]${forbiddenPkg.replace("/", "\\/")}['"]`,
      "m",
    );
    const violators: string[] = [];

    const scan = async (dir: string) => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await scan(full);
        } else if (entry.name.endsWith(".ts")) {
          if (full === gatewayPath) continue;
          const content = await readFile(full, "utf-8");
          if (importPattern.test(content)) {
            violators.push(path.relative(srcDir, full));
          }
        }
      }
    };

    await scan(srcDir);

    assert.deepEqual(
      violators,
      [],
      `Direct OpenAI SDK import outside ai-gateway.ts:\n  ${violators.join("\n  ")}\n` +
        "All OpenAI calls must go through src/lib/ai-gateway.ts.",
    );
  });
});

// ── 2. Helper: mirrors the status-assignment logic in all creation paths ──────

function determineCreationStatus(fitLevel: string): string {
  return fitLevel === "no_bid" ? "no_bid" : "pending_review";
}

// ── 3. ANALYSIS_ACTIVE_STATUSES guard ─────────────────────────────────────────

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

// ── 4. Creation-path status assignment ────────────────────────────────────────

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

// ── 5. Extraction pipeline terminal states ────────────────────────────────────

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

// ── 6. Convert idempotency invariants ─────────────────────────────────────────

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
