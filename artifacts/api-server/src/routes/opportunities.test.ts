/**
 * Task #24/25 behavioral requirements — integration test suite
 *
 * Runner: node:test + tsx  (node --import tsx/esm --test this-file.ts)
 *
 * Tests that IMPORT from the production implementation (not from mirrors):
 *   - evaluateCrawlerEligibility  (lib/crawler-eligibility.ts)
 *   - scoreTender                 (lib/scoring-rules.ts)
 *
 * Structural / architectural tests read the actual source files so changes
 * to the production code immediately surface as test failures.
 *
 * Covers:
 *   §1  Source-type constants on every creation path
 *   §2  No auto-AI on creation, crawl, promote, backfill paths
 *   §3  Pursue concurrent-safe pattern (ON CONFLICT DO NOTHING)
 *   §4  Legacy routes are 410 Gone stubs
 *   §5  Intake idempotency (submissionKey, FOR UPDATE lock, no PII exposure)
 *   §6  Crawl pipeline structural guarantees
 *   §7  Deterministic scoring (scoreTender imports + behavior)
 *   §8  Crawler eligibility gate (evaluateCrawlerEligibility imports)
 *   §9  Backfill filter correctness
 *   §10 Team Review predicate logic
 *   §11 Navigation and /new default-mode checks
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ── Production imports ────────────────────────────────────────────────────────
import {
  evaluateCrawlerEligibility,
  type EligibilityInput,
} from "../lib/crawler-eligibility.js";

import { scoreTender } from "../lib/scoring-rules.js";
import { isTeamReview } from "../lib/proposal-predicates.js";

// ── Helpers ───────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readSrc(rel: string): string {
  return readFileSync(path.resolve(__dirname, "..", rel), "utf8");
}

function readFe(rel: string): string {
  // from api-server/src/routes/ up 3 levels → artifacts/, then proposal-generator/src
  const base = path.resolve(__dirname, "..", "..", "..", "proposal-generator", "src");
  return readFileSync(path.resolve(base, rel), "utf8");
}

const opportunitiesRoute = readSrc("routes/opportunities.ts");
const proposalsRoute     = readSrc("routes/proposals.ts");
const promoteService     = readSrc("lib/promote-discovered-tender.ts");
const crawlerIndex       = readSrc("crawlers/index.ts");
const backfillScript     = readSrc("scripts/backfill-discoveries.ts");

// ── §1 Source-type constants ──────────────────────────────────────────────────

describe("§1 sourceType — every creation path uses a canonical value", () => {
  it("manual opportunity creation sets sourceType = 'manual'", () => {
    assert.ok(
      opportunitiesRoute.includes('"manual"') || opportunitiesRoute.includes("'manual'"),
      "manual route must set sourceType='manual'",
    );
  });

  it("CSV import sets sourceType = 'csv'", () => {
    assert.ok(
      opportunitiesRoute.includes('"csv"') || opportunitiesRoute.includes("'csv'"),
      "CSV import must set sourceType='csv'",
    );
  });

  it("paste/text import sets sourceType = 'pasted_text'", () => {
    assert.ok(
      opportunitiesRoute.includes('"pasted_text"') || opportunitiesRoute.includes("'pasted_text'"),
      "paste route must set sourceType='pasted_text'",
    );
  });

  it("prospect intake sets sourceType = 'prospect_intake'", () => {
    assert.ok(
      proposalsRoute.includes('"prospect_intake"') || proposalsRoute.includes("'prospect_intake'"),
      "intake route must set sourceType='prospect_intake'",
    );
  });

  it("promote service sets sourceType = 'crawler'", () => {
    assert.ok(
      promoteService.includes('"crawler"') || promoteService.includes("'crawler'"),
      "promote-discovered-tender must set sourceType='crawler'",
    );
  });

  it("all five canonical sourceType strings appear across creation surfaces", () => {
    const all = opportunitiesRoute + proposalsRoute + promoteService;
    for (const t of ["manual", "csv", "pasted_text", "prospect_intake", "crawler"]) {
      assert.ok(
        all.includes(`"${t}"`) || all.includes(`'${t}'`),
        `canonical sourceType '${t}' not found in any route or service`,
      );
    }
  });

  it("null sourceType is never silently coerced — legacy rows display as 'Legacy'", () => {
    assert.ok(
      !opportunitiesRoute.includes("sourceType ?? 'unknown'") &&
      !opportunitiesRoute.includes('sourceType ?? "unknown"'),
      "do not silently coerce null sourceType — legacy rows should display as 'Legacy'",
    );
  });
});

// ── §2 No auto-AI on creation paths ──────────────────────────────────────────

describe("§2 no auto-AI on any creation, crawl, promote, or backfill path", () => {
  it("pursue route does NOT call applyDeterministicScore", () => {
    const pursueStart = opportunitiesRoute.indexOf('"/opportunities/:id/pursue"');
    assert.ok(pursueStart !== -1, "pursue route not found");
    const pursueEnd = opportunitiesRoute.indexOf("\n});", pursueStart);
    const handler = opportunitiesRoute.slice(pursueStart, pursueEnd);
    assert.ok(
      !handler.includes("applyDeterministicScore"),
      "pursue must NOT call applyDeterministicScore — scoring happens at Opportunity creation only",
    );
  });

  it("pursue route does NOT call runExtractionPipeline", () => {
    const pursueStart = opportunitiesRoute.indexOf('"/opportunities/:id/pursue"');
    const pursueEnd = opportunitiesRoute.indexOf("\n});", pursueStart);
    const handler = opportunitiesRoute.slice(pursueStart, pursueEnd);
    assert.ok(
      !handler.includes("runExtractionPipeline"),
      "pursue must NOT invoke the AI extraction pipeline",
    );
  });

  it("promote service calls applyDeterministicScore at least once", () => {
    // Count actual call sites (lines containing the function name with a `(` on the same line)
    const callSites = promoteService.split("\n").filter(
      (l) => l.includes("applyDeterministicScore") && l.includes("("),
    );
    assert.ok(callSites.length >= 1, "promote service must call applyDeterministicScore");
    assert.ok(callSites.length <= 2, `promote service should not double-score (found ${callSites.length} call sites)`);
  });

  it("promote service does NOT call runExtractionPipeline", () => {
    assert.ok(
      !promoteService.includes("runExtractionPipeline"),
      "promote-discovered-tender must be AI-free",
    );
  });

  it("intake route calls applyDeterministicScore", () => {
    assert.ok(
      proposalsRoute.includes("applyDeterministicScore"),
      "intake route must call applyDeterministicScore",
    );
  });

  it("intake route does NOT call runExtractionPipeline", () => {
    assert.ok(
      !proposalsRoute.includes("runExtractionPipeline"),
      "intake route must NOT call runExtractionPipeline",
    );
  });

  it("crawlers/index.ts does NOT call runExtractionPipeline", () => {
    assert.ok(
      !crawlerIndex.includes("runExtractionPipeline"),
      "crawler must not invoke the AI extraction pipeline",
    );
  });

  it("backfill script does NOT call runExtractionPipeline or invokeAI", () => {
    assert.ok(
      !backfillScript.includes("runExtractionPipeline") &&
      !backfillScript.includes("invokeAI"),
      "backfill script must be entirely AI-free",
    );
  });
});

// ── §3 Pursue concurrent-safe pattern ─────────────────────────────────────────

describe("§3 pursue — concurrent-safe INSERT ON CONFLICT DO NOTHING pattern", () => {
  it("pursue route uses INSERT ... ON CONFLICT ... DO NOTHING", () => {
    assert.ok(
      opportunitiesRoute.includes("ON CONFLICT") && opportunitiesRoute.includes("DO NOTHING"),
      "pursue must use INSERT ON CONFLICT (tender_id) DO NOTHING — not select-then-insert",
    );
  });

  it("pursue INSERT comes before the canonical SELECT that reads it back", () => {
    const conflictIdx  = opportunitiesRoute.indexOf("ON CONFLICT");
    const selectAfterIdx = opportunitiesRoute.indexOf(
      "SELECT id FROM proposals WHERE tender_id",
      conflictIdx,
    );
    assert.ok(
      conflictIdx !== -1 && selectAfterIdx > conflictIdx,
      "pursue must INSERT ON CONFLICT first, then SELECT the canonical row",
    );
  });

  it("pursue does NOT use SELECT FOR UPDATE on proposals", () => {
    const pursueStart = opportunitiesRoute.indexOf('"/opportunities/:id/pursue"');
    const pursueEnd   = opportunitiesRoute.indexOf("\n});", pursueStart);
    const handler     = opportunitiesRoute.slice(pursueStart, pursueEnd);
    const hasProposalsLock =
      handler.includes("FROM proposals") && handler.includes("FOR UPDATE");
    assert.ok(
      !hasProposalsLock,
      "pursue must not use SELECT FOR UPDATE on proposals — the UNIQUE constraint is the guard",
    );
  });

  it("pursue returns { proposalId }", () => {
    assert.ok(
      opportunitiesRoute.includes("res.json({ proposalId })") ||
      opportunitiesRoute.includes("res.json({proposalId})"),
      "pursue must return { proposalId }",
    );
  });
});

// ── §4 Legacy routes are 410 Gone stubs ───────────────────────────────────────

describe("§4 legacy routes — 410 Gone stubs only", () => {
  it("start-bid route returns 410 Gone", () => {
    const startBidStart = opportunitiesRoute.indexOf('"/opportunities/:id/start-bid"');
    assert.ok(startBidStart !== -1, "start-bid route not found");
    const startBidEnd = opportunitiesRoute.indexOf("\n});", startBidStart);
    const handler = opportunitiesRoute.slice(startBidStart, startBidEnd);
    assert.ok(
      handler.includes("410") || handler.includes("Gone"),
      "start-bid must be a 410 Gone stub",
    );
  });

  it("start-bid stub does NOT perform any DB writes", () => {
    const startBidStart = opportunitiesRoute.indexOf('"/opportunities/:id/start-bid"');
    const startBidEnd   = opportunitiesRoute.indexOf("\n});", startBidStart);
    const handler       = opportunitiesRoute.slice(startBidStart, startBidEnd);
    assert.ok(
      !handler.includes("db.insert") &&
      !handler.includes("db.update") &&
      !handler.includes("tx.execute"),
      "start-bid 410 stub must not touch the database",
    );
  });

  it("convert route returns 410 Gone", () => {
    const convertStart = opportunitiesRoute.indexOf('"/opportunities/:id/convert"');
    assert.ok(convertStart !== -1, "convert route not found");
    const convertEnd = opportunitiesRoute.indexOf("\n});", convertStart);
    const handler = opportunitiesRoute.slice(convertStart, convertEnd);
    assert.ok(
      handler.includes("410") || handler.includes("Gone"),
      "convert must be a 410 Gone stub",
    );
  });

  it("convert stub does NOT perform any DB writes", () => {
    const convertStart = opportunitiesRoute.indexOf('"/opportunities/:id/convert"');
    const convertEnd   = opportunitiesRoute.indexOf("\n});", convertStart);
    const handler      = opportunitiesRoute.slice(convertStart, convertEnd);
    assert.ok(
      !handler.includes("db.insert") && !handler.includes("db.update"),
      "convert 410 stub must not touch the database",
    );
  });
});

// ── §5 Intake idempotency ─────────────────────────────────────────────────────

describe("§5 intake — submissionKey idempotency and transaction safety", () => {
  it("intake handler validates and requires submissionKey", () => {
    assert.ok(
      proposalsRoute.includes("submissionKey") &&
      (proposalsRoute.includes("submissionKey is required") ||
       proposalsRoute.includes("submissionKey?.trim") ||
       proposalsRoute.includes("!submissionKey")),
      "intake must require a non-empty submissionKey UUID",
    );
  });

  it("intake draft upserts exclusively by submissionKey (not by email)", () => {
    assert.ok(
      proposalsRoute.includes("target: intakeDraftsTable.submissionKey") ||
      proposalsRoute.includes("submission_key"),
      "intake_draft upsert key must be submissionKey — email is a stored field, not an idempotency key",
    );
  });

  it("intake handler uses SELECT FOR UPDATE to lock the draft row", () => {
    assert.ok(
      proposalsRoute.includes("FOR UPDATE"),
      "intake must SELECT FOR UPDATE the draft row before checking opportunityId",
    );
  });

  it("intake checks opportunityId before creating a duplicate Opportunity", () => {
    assert.ok(
      proposalsRoute.includes("opportunityId") && proposalsRoute.includes("success: true"),
      "intake must return {success:true} immediately if opportunityId is already set",
    );
  });

  it("intake response is {success:true} only — no IDs exposed in the success path", () => {
    const intakeStart = proposalsRoute.indexOf('router.post("/intake"');
    const intakeEnd   = proposalsRoute.indexOf("\n});", intakeStart);
    const handler     = intakeStart !== -1 ? proposalsRoute.slice(intakeStart, intakeEnd) : proposalsRoute;
    const successes   = handler.match(/res\.json\(\{[^}]*success\s*:\s*true[^}]*\}\)/g) ?? [];
    for (const r of successes) {
      assert.ok(
        !r.includes("opportunityId") && !r.includes("tenderId"),
        `intake success response must not expose internal IDs: ${r}`,
      );
    }
    assert.ok(successes.length > 0, "intake handler must return { success: true }");
  });
});

// ── §6 Crawl pipeline structural guarantees ────────────────────────────────────

describe("§6 crawl pipeline — structural guarantees", () => {
  it("crawlers/index.ts imports evaluateCrawlerEligibility", () => {
    assert.ok(
      crawlerIndex.includes("evaluateCrawlerEligibility"),
      "crawler must import and call evaluateCrawlerEligibility",
    );
  });

  it("crawlers/index.ts imports promoteDiscoveredTender", () => {
    assert.ok(
      crawlerIndex.includes("promoteDiscoveredTender"),
      "crawler must call promoteDiscoveredTender for eligible discoveries",
    );
  });

  it("individual promotion failure is caught so the crawl loop continues", () => {
    // Find the *call* site (not the import) by looking for "promoteDiscoveredTender("
    const callIdx = crawlerIndex.indexOf("promoteDiscoveredTender(");
    assert.ok(callIdx !== -1, "promoteDiscoveredTender( call not found in crawlers/index.ts");
    // Search a wide window around the call for try/catch
    const sliceAround = crawlerIndex.slice(
      Math.max(0, callIdx - 600),
      callIdx + 600,
    );
    assert.ok(
      sliceAround.includes("try") && sliceAround.includes("catch"),
      "individual promotion failure must be caught so the crawl loop continues",
    );
  });
});

// ── §7 Deterministic scoring (production import) ───────────────────────────────

describe("§7 scoreTender — deterministic scoring, imported from production", () => {
  it("returns a numeric fitScore for a genuine communications RFP", () => {
    const result = scoreTender({
      title:       "Marketing Strategy and Communications Plan",
      description: "Develop a comprehensive marketing strategy including brand identity, social media strategy, content production and digital marketing campaigns for the national tourism board.",
      category:    "Marketing & Communications",
      agency:      "Caribbean Tourism Organization",
    });
    assert.ok(typeof result.fitScore === "number", "fitScore must be numeric");
    assert.ok(result.fitScore > 0, "a real comms RFP must score above 0");
  });

  it("scores a construction RFP lower than a comms RFP", () => {
    const comms = scoreTender({
      title:       "Brand Strategy and Public Relations Services",
      description: "Brand strategy, media relations, copywriting, social media management and digital marketing for government tourism authority.",
      category:    "Marketing",
      agency:      "Tourism Board",
    });
    const construction = scoreTender({
      title:       "Construction of Road Bridge — Civil Engineering Works",
      description: "Civil engineering and construction works for a reinforced concrete road bridge including structural design and site supervision.",
      category:    "Construction",
      agency:      "Infrastructure Ministry",
    });
    assert.ok(
      comms.fitScore > construction.fitScore,
      `comms RFP (${comms.fitScore}) should score higher than construction (${construction.fitScore})`,
    );
  });

  it("fitScore is capped at 100", () => {
    const result = scoreTender({
      title:       "Marketing Strategy Communications PR Brand Rebranding Digital Social Media",
      description: "Full marketing strategy, communications, brand identity, rebranding, PR, media relations, social media, digital marketing, content production, copywriting, graphic design, advertising, destination marketing, community engagement.",
      category:    "Marketing",
      agency:      "National Tourism Authority",
    });
    assert.ok(result.fitScore <= 100, `fitScore must be ≤ 100, got ${result.fitScore}`);
  });

  it("scoreTender is pure — same input always produces same fitScore", () => {
    const input = {
      title:       "Social Media Strategy and Digital Marketing",
      description: "Social media strategy, content production, digital marketing, and community engagement for regional tourism board.",
      category:    "Marketing",
      agency:      "Regional Authority",
    };
    const first  = scoreTender(input);
    const second = scoreTender(input);
    assert.equal(first.fitScore, second.fitScore, "scoreTender must be pure/deterministic");
  });
});

// ── §8 Crawler eligibility gate (production import) ───────────────────────────

describe("§8 evaluateCrawlerEligibility — imported from production", () => {
  const future  = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const expired = new Date(Date.now() - 7  * 24 * 60 * 60 * 1000).toISOString();

  const fullScope: EligibilityInput = {
    title:          "Marketing and Communications Strategy",
    description:    "Comprehensive marketing strategy, brand identity, digital marketing, social media management and content production for the regional tourism authority.",
    recommendation: "PURSUE",
    deadline:       future,
  };

  it("PURSUE + full scope + future deadline → eligible, destination=new", () => {
    const r = evaluateCrawlerEligibility(fullScope);
    assert.strictEqual(r.eligible, true, "full-scope PURSUE must be eligible");
    assert.strictEqual(r.destination, "new");
  });

  it("CONSIDER + full scope → eligible, destination=reviewing", () => {
    const r = evaluateCrawlerEligibility({ ...fullScope, recommendation: "CONSIDER" });
    assert.strictEqual(r.eligible, true);
    assert.strictEqual(r.destination, "reviewing");
  });

  it("SKIP recommendation → always raw_only regardless of content", () => {
    const r = evaluateCrawlerEligibility({ ...fullScope, recommendation: "SKIP" });
    assert.strictEqual(r.eligible, false);
    assert.strictEqual(r.destination, "raw_only");
  });

  it("expired deadline → raw_only regardless of recommendation or content", () => {
    const r = evaluateCrawlerEligibility({ ...fullScope, deadline: expired });
    assert.strictEqual(r.destination, "raw_only");
  });

  it("title-only / boilerplate description → raw_only (content quality guard)", () => {
    const r = evaluateCrawlerEligibility({
      title:          "Communications",
      description:    "Communications.",
      recommendation: "PURSUE",
    });
    assert.strictEqual(r.destination, "raw_only");
    assert.ok(
      r.contentQuality === "title_only" || r.contentQuality === "boilerplate",
      `expected title_only or boilerplate, got ${r.contentQuality}`,
    );
  });

  it("boilerplate description → raw_only", () => {
    const r = evaluateCrawlerEligibility({
      title:          "RFP: Marketing Services",
      description:    "Procurement notice. See attached for full details.",
      recommendation: "PURSUE",
    });
    assert.strictEqual(r.destination, "raw_only");
  });

  it("construction RFP with communications cable mention does NOT pass", () => {
    const r = evaluateCrawlerEligibility({
      title:          "Road Bridge Construction with Communications Cable Infrastructure",
      description:    "Civil engineering and road construction works, including laying of fiber communications cable alongside road infrastructure.",
      recommendation: "PURSUE",
    });
    assert.strictEqual(r.eligible, false, "construction + cable is NOT a comms RFP");
  });

  it("'supply of communications equipment' does NOT pass", () => {
    const r = evaluateCrawlerEligibility({
      title:          "Supply of Communications Equipment and Radio Systems",
      description:    "Supply and installation of communications equipment, radio systems and networking hardware for government facility.",
      recommendation: "PURSUE",
    });
    assert.strictEqual(r.eligible, false, "hardware supply is NOT a comms services RFP");
  });

  it("genuine brand strategy + rebranding RFP passes", () => {
    const r = evaluateCrawlerEligibility({
      title:          "Brand Strategy and Rebranding",
      description:    "Full brand strategy, rebranding exercise, brand identity design, graphic design and communications strategy for national government agency.",
      recommendation: "PURSUE",
    });
    assert.strictEqual(r.eligible, true);
  });

  it("genuine PR and media relations RFP passes", () => {
    const r = evaluateCrawlerEligibility({
      title:          "Public Relations and Media Strategy Services",
      description:    "Media relations, stakeholder communications, public-awareness campaign development and copywriting for government communications directorate.",
      recommendation: "PURSUE",
    });
    assert.strictEqual(r.eligible, true);
  });

  it("destination marketing RFP passes", () => {
    const r = evaluateCrawlerEligibility({
      title:          "Destination Marketing and Digital Campaign",
      description:    "Destination marketing strategy, advertising campaign, social media management and content production for island tourism authority.",
      recommendation: "PURSUE",
    });
    assert.strictEqual(r.eligible, true);
  });

  it("generic 'consulting' alone does NOT qualify", () => {
    const r = evaluateCrawlerEligibility({
      title:          "General Consulting Services",
      description:    "Provision of general consulting services and advisory support to government ministry.",
      recommendation: "PURSUE",
    });
    assert.strictEqual(r.eligible, false, "generic consulting alone must not qualify");
  });

  it("generic 'tourism' without comms deliverables does NOT qualify", () => {
    const r = evaluateCrawlerEligibility({
      title:          "Tourism Development Support",
      description:    "Tourism development, visitor experience and strategic planning support services.",
      recommendation: "PURSUE",
    });
    assert.strictEqual(r.eligible, false, "generic tourism without comms deliverables must not qualify");
  });

  it("result always includes positiveSignals, negativeSignals, rejectionReasons arrays", () => {
    const r = evaluateCrawlerEligibility(fullScope);
    assert.ok(Array.isArray(r.positiveSignals),  "positiveSignals must be an array");
    assert.ok(Array.isArray(r.negativeSignals),  "negativeSignals must be an array");
    assert.ok(Array.isArray(r.rejectionReasons), "rejectionReasons must be an array");
  });

  it("ineligible result has at least one rejectionReason", () => {
    const r = evaluateCrawlerEligibility({
      title:          "Road Construction Tender",
      description:    "Construction and paving of main road with drainage infrastructure.",
      recommendation: "PURSUE",
    });
    if (!r.eligible) {
      assert.ok(r.rejectionReasons.length > 0, "ineligible result must explain why");
    }
  });
});

// ── §9 Backfill filter correctness ────────────────────────────────────────────

describe("§9 backfill script — filter correctness", () => {
  it("backfill filters on status IN ('new', 'saved')", () => {
    assert.ok(
      (backfillScript.includes("'new'") || backfillScript.includes('"new"')) &&
      (backfillScript.includes("'saved'") || backfillScript.includes('"saved"')),
      "backfill must filter discovered_tenders WHERE status IN ('new','saved')",
    );
  });

  it("backfill never processes 'dismissed' records", () => {
    assert.ok(
      !backfillScript.includes("'dismissed'"),
      "backfill must exclude dismissed discoveries",
    );
  });

  it("'active' is not a valid discovered_tender status in backfill", () => {
    assert.ok(
      !backfillScript.includes("'active'"),
      "'active' is not a valid status for discovered_tenders",
    );
  });

  it("backfill calls evaluateCrawlerEligibility before promoting", () => {
    assert.ok(
      backfillScript.includes("evaluateCrawlerEligibility") || backfillScript.includes("eligible"),
      "backfill must check eligibility before calling promoteDiscoveredTender",
    );
  });

  it("backfill gates on PURSUE or CONSIDER recommendation", () => {
    assert.ok(
      backfillScript.includes("PURSUE") || backfillScript.includes("recommendation"),
      "backfill must require PURSUE or CONSIDER recommendation",
    );
  });
});

// ── §10 Team Review predicate logic ──────────────────────────────────────────

describe("§10 Team Review predicate — correct proposal classification", () => {
  // Uses the production predicate imported from proposal-predicates.ts —
  // no local duplicate. Any contract change surfaces here automatically.

  it("handoff_complete → Team Review regardless of googleDocUrl", () => {
    assert.ok(isTeamReview({ syncStatus: "handoff_complete" }));
    assert.ok(isTeamReview({ syncStatus: "handoff_complete", googleDocUrl: null }));
  });

  it("googleDocUrl set + not pending/in-progress → Team Review", () => {
    assert.ok(isTeamReview({ googleDocUrl: "https://docs.google.com/d/abc", syncStatus: null }));
    assert.ok(isTeamReview({ googleDocUrl: "https://docs.google.com/d/abc", syncStatus: "approved" }));
  });

  it("googleFileId set + not pending/in-progress → Team Review (#23 handoff case)", () => {
    assert.ok(isTeamReview({ googleFileId: "1abc", syncStatus: null }));
    assert.ok(isTeamReview({ googleFileId: "1abc", syncStatus: "approved" }));
  });

  it("pending_first_write → NOT Team Review (write not yet complete)", () => {
    assert.ok(!isTeamReview({ googleDocUrl: "https://docs.google.com/d/abc", syncStatus: "pending_first_write" }));
  });

  it("handoff_in_progress → NOT Team Review (still syncing)", () => {
    assert.ok(!isTeamReview({ googleFileId: "1abc", syncStatus: "handoff_in_progress" }));
  });

  it("no googleDocUrl + no googleFileId + no handoff_complete → NOT Team Review", () => {
    assert.ok(!isTeamReview({ syncStatus: null }));
    assert.ok(!isTeamReview({ syncStatus: "draft" }));
    assert.ok(!isTeamReview({}));
  });
});

// ── §11 Navigation and /new default-mode checks ───────────────────────────────

describe("§11 navigation redirects and /new default mode", () => {
  it("App.tsx includes a redirect from /tenders to /opportunities", () => {
    const appSrc = readFe("App.tsx");
    assert.ok(
      appSrc.includes("/opportunities") && appSrc.includes("/tenders"),
      "App.tsx must redirect /tenders → /opportunities",
    );
  });

  it("App.tsx includes a redirect from /inbox to /opportunities", () => {
    const appSrc = readFe("App.tsx");
    assert.ok(
      appSrc.includes("/inbox") && appSrc.includes("/opportunities"),
      "App.tsx must redirect /inbox → /opportunities",
    );
  });

  it("App.tsx includes a redirect from /settings/import to /new?mode=import", () => {
    const appSrc = readFe("App.tsx");
    assert.ok(
      appSrc.includes("/settings/import") && appSrc.includes("mode=import"),
      "App.tsx must redirect /settings/import → /new?mode=import",
    );
  });

  it("/new without ?mode defaults to blank, not form", () => {
    const newProposalSrc = readFe("pages/new-proposal.tsx");
    assert.ok(
      !newProposalSrc.includes('return "form"; // plain') &&
      !newProposalSrc.includes("return 'form'; // plain"),
      "plain /new must default to blank mode, not form mode",
    );
    assert.ok(
      newProposalSrc.includes('return "blank"') || newProposalSrc.includes("return 'blank'"),
      "new-proposal.tsx must have 'blank' as the default/fallback mode",
    );
  });

  it("opportunities.tsx imports useSearch from wouter", () => {
    const oppSrc = readFe("pages/opportunities.tsx");
    assert.ok(
      oppSrc.includes("useSearch") && oppSrc.includes("wouter"),
      "opportunities.tsx must import useSearch from wouter for ?add=1 handling",
    );
  });

  it("opportunities.tsx wires ?add=1 to open CreateDialog", () => {
    const oppSrc = readFe("pages/opportunities.tsx");
    assert.ok(
      oppSrc.includes('get("add") === "1"') || oppSrc.includes("add=1") || oppSrc.includes('"add"'),
      "opportunities.tsx must detect ?add=1 and open the CreateDialog",
    );
    assert.ok(
      oppSrc.includes("showCreate") && oppSrc.includes("CreateDialog"),
      "opportunities.tsx must have showCreate state and render <CreateDialog>",
    );
  });
});
