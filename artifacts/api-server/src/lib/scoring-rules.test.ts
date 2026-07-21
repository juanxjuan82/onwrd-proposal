/**
 * Deterministic scoring engine — unit tests
 *
 * Runner: node:test + tsx/esm (no extra packages required)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreTender, calcCompleteness, FIT_THRESHOLDS } from "./scoring-rules.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fullTender(
  overrides: Partial<Parameters<typeof scoreTender>[0]> = {},
): Parameters<typeof scoreTender>[0] {
  return {
    title:       "Digital Marketing and Brand Strategy Services",
    agency:      "Ministry of Tourism, Bahamas",
    category:    "Marketing",
    description:
      "The Ministry of Tourism seeks a qualified marketing agency to develop and execute " +
      "a comprehensive digital marketing strategy for the 2025 tourism season, covering " +
      "social media, content production, and campaign management.",
    deadline:    new Date(Date.now() + 30 * 86_400_000),
    valueAmount: "BSD $250,000",
    rawText:
      "Full RFP details: scope includes social media management, content creation, " +
      "campaign strategy, and performance reporting. Agency must have Caribbean tourism " +
      "marketing experience. Proposals evaluated on technical merit and price.",
    ...overrides,
  };
}

// ── scoreTender ───────────────────────────────────────────────────────────────

describe("scoreTender", () => {
  it("overrides to no_bid for individual employment postings", () => {
    const result = scoreTender({
      title:       "Marketing Manager – Vacancy",
      agency:      "Royal Bank",
      category:    "Employment",
      description:
        "We are seeking an experienced Marketing Manager to join our team. " +
        "Full-time position, competitive salary range, benefits package. " +
        "Send your CV to hr@example.com.",
    });
    assert.strictEqual(result.fitScore, 0);
    assert.strictEqual(result.fitLevel, "no_bid");
    assert.match(result.flags[0], /Individual employment role/i);
  });

  it("gives strong score for a Bahamas marketing RFP with a complete brief", () => {
    const result = scoreTender(fullTender());
    assert.ok(
      result.fitScore >= FIT_THRESHOLDS.strong,
      `Expected fitScore ≥ ${FIT_THRESHOLDS.strong}, got ${result.fitScore}`,
    );
    assert.strictEqual(result.fitLevel, "strong");
  });

  it("gives moderate-or-better for a Caribbean adjacent-service RFP", () => {
    const result = scoreTender({
      title:       "Brand Strategy for Caribbean Festival",
      agency:      "Caribbean Tourism Organisation",
      category:    "Consulting",
      description:
        "We seek proposals for brand strategy and stakeholder communications " +
        "planning for a regional festival. Research and outreach components included.",
      deadline:    new Date(Date.now() + 20 * 86_400_000),
      valueAmount: "USD $80,000",
    });
    assert.ok(
      result.fitScore >= FIT_THRESHOLDS.moderate,
      `Expected fitScore ≥ ${FIT_THRESHOLDS.moderate}, got ${result.fitScore}`,
    );
  });

  it("gives weak or no_bid score for a construction tender", () => {
    const result = scoreTender({
      title:       "Construction of New Government Building",
      agency:      "Ministry of Works",
      category:    "Construction",
      description:
        "Civil engineering contractor required for the construction of a 5-storey " +
        "government administrative building. Must hold construction contractor licence.",
    });
    assert.ok(
      result.fitScore < FIT_THRESHOLDS.moderate,
      `Expected fitScore < ${FIT_THRESHOLDS.moderate}, got ${result.fitScore}`,
    );
  });

  it("applies a larger deadline penalty for very close deadlines", () => {
    const far   = scoreTender(fullTender({ deadline: new Date(Date.now() + 30 * 86_400_000) }));
    const close = scoreTender(fullTender({ deadline: new Date(Date.now() + 2  * 86_400_000) }));
    assert.ok(
      close.fitScore < far.fitScore,
      `Close deadline should score lower (${close.fitScore} < ${far.fitScore})`,
    );
  });

  it("applies maximum deadline penalty when deadline has passed", () => {
    const past   = scoreTender(fullTender({ deadline: new Date(Date.now() - 86_400_000) }));
    const future = scoreTender(fullTender({ deadline: new Date(Date.now() + 30 * 86_400_000) }));
    assert.ok(
      past.fitScore <= future.fitScore - 20,
      `Past deadline should be at least 20 pts lower (${past.fitScore} vs ${future.fitScore})`,
    );
    const hasPassedFlag = past.flags.some((f) => /passed/i.test(f));
    assert.ok(hasPassedFlag, "Expected a 'deadline passed' flag");
  });

  it("scores Bahamas geography higher than no-geography tender", () => {
    const bahamas = scoreTender(fullTender());
    const generic = scoreTender(fullTender({
      title:       "Digital Marketing Services",
      agency:      "Department of Trade",
      description:
        "Marketing services required for international trade promotion campaign " +
        "targeting global audiences across multiple regions and sectors.",
      rawText: null,
    }));
    assert.ok(
      bahamas.fitScore > generic.fitScore,
      `Bahamas tender should score higher (${bahamas.fitScore} > ${generic.fitScore})`,
    );
  });

  it("fitScore is always clamped to 0-100", () => {
    const cases: Parameters<typeof scoreTender>[0][] = [
      fullTender({ deadline: new Date(Date.now() - 86_400_000) }),
      { title: "X", agency: "Y", category: "Z", description: "" },
      fullTender(),
    ];
    for (const t of cases) {
      const { fitScore } = scoreTender(t);
      assert.ok(fitScore >= 0 && fitScore <= 100, `fitScore out of range: ${fitScore}`);
    }
  });

  it("returns a non-empty reasoning string", () => {
    const { reasoning } = scoreTender(fullTender());
    assert.ok(typeof reasoning === "string" && reasoning.length > 20);
  });

  it("flags array is non-empty", () => {
    const { flags } = scoreTender(fullTender());
    assert.ok(Array.isArray(flags) && flags.length > 0);
  });
});

// ── calcCompleteness ──────────────────────────────────────────────────────────

describe("calcCompleteness", () => {
  it("returns 100 for a fully-specified brief", () => {
    const { score } = calcCompleteness({
      title:       "Marketing Services",
      agency:      "Tourism Board",
      category:    "Marketing",
      description:
        "A detailed description that is well over two hundred characters in length " +
        "and provides ample context about the scope, deliverables, and expectations " +
        "for the engagement with the winning agency or firm.",
      deadline:    new Date(Date.now() + 30 * 86_400_000),
      valueAmount: "BSD $200,000",
      rawText:
        "Full RFP text: the procurement covers social media, brand strategy, content " +
        "creation, campaign management, reporting, and consultation. Agency must have " +
        "a minimum of five years Caribbean experience in marketing services.",
    });
    assert.strictEqual(score, 100);
  });

  it("reports missing fields for an incomplete brief", () => {
    const { missingFields } = calcCompleteness({
      title:       "Vague RFP",
      agency:      "Unknown Agency",
      category:    "General",
      description: "Short desc.",
    });
    assert.ok(missingFields.includes("Deadline not specified"));
    assert.ok(missingFields.includes("Budget / contract value not specified"));
    assert.ok(missingFields.includes("Full RFP text not provided"));
  });

  it("returns score 0 for an empty description with no other fields", () => {
    const { score } = calcCompleteness({
      title:       "T",
      agency:      "A",
      category:    "C",
      description: "",
    });
    assert.strictEqual(score, 0);
  });

  it("missingFields is empty for a complete brief", () => {
    const { missingFields } = calcCompleteness({
      title:       "Full Brief",
      agency:      "Ministry",
      category:    "Marketing",
      description: "A ".repeat(110),
      deadline:    new Date(Date.now() + 30 * 86_400_000),
      valueAmount: "BSD $100,000",
      rawText:     "Full text here. ".repeat(15),
    });
    assert.strictEqual(missingFields.length, 0);
  });
});
