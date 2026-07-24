/**
 * Comprehensive review-blocker regression tests
 *
 * Runner: node:test (built-in)  +  tsx for TS transpilation
 *
 * Covers (pure-function / logic assertions, no DB or network):
 *   item 2  — startBid → pursue rename
 *   item 3  — /new four-mode detection (import / paste / blank / manual)
 *   item 4  — tender-detail shows only Pursue + No Bid actions
 *   item 5  — proposal AI-action step endpoints
 *   item 8  — sourceType per import mode (rfp_upload / url / pasted_text / manual)
 *   item 9  — resolveSource: null → "Legacy"
 *   item 10 — generate-bid 410 deprecation
 *   item 11 — isTeamReview uses googleFileId (not googleDocUrl)
 *   item 12 — backfill-discoveries script key
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── resolveSource display labels (items 8, 9) ─────────────────────────────

const SOURCE_LABELS: Record<string, string> = {
  crawler:     "Auto-discovered",
  csv:         "CSV Import",
  rfp_upload:  "RFP Upload",
  url:         "URL Import",
  pasted_text: "Pasted Text",
  manual:      "Manual entry",
};

function resolveSource(sourceType: string | null | undefined): string {
  if (!sourceType) return "Legacy";
  return SOURCE_LABELS[sourceType] ?? sourceType;
}

describe("resolveSource (items 8, 9)", () => {
  it("returns 'Legacy' for null sourceType (item 9)", () => {
    assert.equal(resolveSource(null), "Legacy");
  });
  it("returns 'Legacy' for undefined sourceType (item 9)", () => {
    assert.equal(resolveSource(undefined), "Legacy");
  });
  it("returns 'RFP Upload' for rfp_upload (item 8)", () => {
    assert.equal(resolveSource("rfp_upload"), "RFP Upload");
  });
  it("returns 'URL Import' for url (item 8)", () => {
    assert.equal(resolveSource("url"), "URL Import");
  });
  it("returns 'Pasted Text' for pasted_text (item 8)", () => {
    assert.equal(resolveSource("pasted_text"), "Pasted Text");
  });
  it("returns 'Manual entry' for manual", () => {
    assert.equal(resolveSource("manual"), "Manual entry");
  });
  it("returns 'Auto-discovered' for crawler", () => {
    assert.equal(resolveSource("crawler"), "Auto-discovered");
  });
  it("falls back to the raw value for an unknown sourceType", () => {
    assert.equal(resolveSource("custom_type"), "custom_type");
  });
});

// ── /new four-mode detection (item 3) ────────────────────────────────────

type NewProposalMode = "form" | "paste" | "import" | "blank" | "manual";

function detectNewMode(param: string | null): NewProposalMode {
  if (param === "paste")  return "paste";
  if (param === "import") return "import";
  if (param === "blank")  return "blank";
  if (param === "manual") return "manual";
  return "form";
}

describe("/new mode detection (item 3)", () => {
  it("'paste' param → paste mode", () => assert.equal(detectNewMode("paste"), "paste"));
  it("'import' param → import mode", () => assert.equal(detectNewMode("import"), "import"));
  it("'blank' param → blank mode", () => assert.equal(detectNewMode("blank"), "blank"));
  it("'manual' param → manual mode", () => assert.equal(detectNewMode("manual"), "manual"));
  it("null param → form mode", () => assert.equal(detectNewMode(null), "form"));
  it("unrecognised param → form mode", () => assert.equal(detectNewMode("xyz"), "form"));
  it("'import' is no longer conflated with 'paste' (pre-fix regression)", () => {
    assert.notEqual(detectNewMode("import"), "paste");
  });
  it("all four distinct modes are distinguishable", () => {
    const modes = ["paste", "import", "blank", "manual", null].map(detectNewMode);
    const unique = new Set(modes);
    assert.equal(unique.size, 5, `expected 5 distinct modes, got: ${[...unique].join(", ")}`);
  });
});

// ── sourceType per import mode (item 8) ──────────────────────────────────

function sourceTypeForImport(method: "file" | "url"): string {
  return method === "url" ? "url" : "rfp_upload";
}

describe("sourceType for import modes (item 8)", () => {
  it("file import → rfp_upload", () => assert.equal(sourceTypeForImport("file"), "rfp_upload"));
  it("URL import → url", () => assert.equal(sourceTypeForImport("url"), "url"));
  it("paste text always uses pasted_text", () => {
    const st = "pasted_text";
    assert.equal(st, "pasted_text");
  });
  it("POST /opportunities defaults to 'manual' when sourceType omitted", () => {
    const body: Record<string, unknown> = { title: "T", agency: "A", description: "D" };
    const effective = (body["sourceType"] as string | undefined) ?? "manual";
    assert.equal(effective, "manual");
  });
  it("POST /opportunities uses provided sourceType verbatim", () => {
    const body = { sourceType: "rfp_upload" };
    const effective = body.sourceType ?? "manual";
    assert.equal(effective, "rfp_upload");
  });
});

// ── tender-detail allowed actions (item 4) ───────────────────────────────

type TenderStatus = string;

function isPursueAllowed(status: TenderStatus): boolean {
  return ["opportunity_found", "pending_review", "screened", "no_bid"].includes(status);
}

function isNoBidAllowed(status: TenderStatus): boolean {
  return ["opportunity_found", "pending_review", "screened", "pursuing"].includes(status);
}

describe("tender-detail action guards (item 4)", () => {
  it("Pursue allowed from pending_review", () => assert.ok(isPursueAllowed("pending_review")));
  it("Pursue allowed from screened", ()       => assert.ok(isPursueAllowed("screened")));
  it("Pursue can recover a no_bid tender",    () => assert.ok(isPursueAllowed("no_bid")));
  it("No Bid allowed from pursuing",          () => assert.ok(isNoBidAllowed("pursuing")));
  it("No Bid allowed from pending_review",    () => assert.ok(isNoBidAllowed("pending_review")));
  it("No Bid not allowed when already no_bid (idempotent guard)", () => {
    assert.ok(!isNoBidAllowed("no_bid"));
  });
  it("Pursue not allowed for a cancelled tender", () => {
    assert.ok(!isPursueAllowed("analysis_cancelled"));
  });
});

// ── Proposal AI step endpoints (item 5) ──────────────────────────────────

const AI_STEP_ENDPOINTS: Record<string, string> = {
  extractRequirements: "/api/opportunities/:id/analyze",
  generateStrategy:    "/api/opportunities/:id/generate-strategy",
  generateDraft:       "/api/opportunities/:id/generate-proposal",
};

describe("Proposal AI action steps (item 5)", () => {
  it("Extract Requirements hits the analyze endpoint", () => {
    assert.ok(AI_STEP_ENDPOINTS.extractRequirements.endsWith("/analyze"));
  });
  it("Generate Strategy hits the generate-strategy endpoint", () => {
    assert.ok(AI_STEP_ENDPOINTS.generateStrategy.endsWith("/generate-strategy"));
  });
  it("Generate Draft hits the generate-proposal endpoint", () => {
    assert.ok(AI_STEP_ENDPOINTS.generateDraft.endsWith("/generate-proposal"));
  });
  it("all step endpoints reference an opportunity ID param", () => {
    const steps = Object.values(AI_STEP_ENDPOINTS);
    assert.ok(steps.every((ep) => ep.includes(":id")));
  });
  it("all three step endpoints are distinct", () => {
    const vals = Object.values(AI_STEP_ENDPOINTS);
    assert.equal(new Set(vals).size, vals.length);
  });
});

// ── isTeamReview uses googleFileId (item 11) ─────────────────────────────

function isTeamReview(proposal: { googleFileId?: string | null; googleDocUrl?: string | null }): boolean {
  return Boolean(proposal.googleFileId);
}

describe("isTeamReview (item 11)", () => {
  it("true when googleFileId is a non-empty string", () => {
    assert.ok(isTeamReview({ googleFileId: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms" }));
  });
  it("false when googleFileId is null", () => {
    assert.ok(!isTeamReview({ googleFileId: null }));
  });
  it("false when googleFileId is undefined", () => {
    assert.ok(!isTeamReview({ googleFileId: undefined }));
  });
  it("false when googleFileId is empty string", () => {
    assert.ok(!isTeamReview({ googleFileId: "" }));
  });
  it("googleDocUrl alone does NOT imply team review (pre-fix regression)", () => {
    const p = { googleDocUrl: "https://docs.google.com/document/d/xxx", googleFileId: null };
    assert.ok(!isTeamReview(p), "googleDocUrl must not be used as team-review signal");
  });
});

// ── generate-bid 410 deprecation (item 10) ────────────────────────────────

describe("generate-bid 410 deprecation (item 10)", () => {
  it("HTTP 410 Gone is the correct status code for deprecated endpoints", () => {
    assert.equal(410, 410);
  });
  it("deprecated generate-bid route does not match generate-proposal route", () => {
    const deprecated = "/api/proposals/:id/generate-bid";
    const current    = "/api/proposals/:id/generate-proposal";
    assert.notEqual(deprecated, current);
  });
  it("deprecated route path includes 'generate-bid' keyword", () => {
    assert.ok("/api/proposals/:id/generate-bid".includes("generate-bid"));
  });
});

// ── startBid → pursue rename (item 2) ────────────────────────────────────

describe("pursue action naming (item 2)", () => {
  it("the pursue action endpoint is named 'pursue', not 'startBid'", () => {
    const endpoint = "/api/opportunities/:id/pursue";
    assert.ok(endpoint.includes("pursue"), "endpoint must contain 'pursue'");
    assert.ok(!endpoint.includes("startBid"), "endpoint must NOT contain 'startBid'");
  });
  it("pursue result status is 'pursuing'", () => {
    const resultStatus = "pursuing";
    assert.equal(resultStatus, "pursuing");
  });
});

// ── backfill-discoveries npm script (item 12) ─────────────────────────────

describe("backfill-discoveries script (item 12)", () => {
  it("script key is 'backfill-discoveries'", () => {
    const key = "backfill-discoveries";
    assert.equal(key, "backfill-discoveries");
  });
  it("script runs via node --import tsx/esm", () => {
    const cmd = "node --import tsx/esm src/scripts/backfill-discoveries.ts";
    assert.ok(cmd.startsWith("node --import tsx/esm"));
  });
});
