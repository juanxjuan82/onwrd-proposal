import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { evaluateCrawlerEligibility } from "./crawler-eligibility.js";

// ── Reusable fixture helpers ──────────────────────────────────────────────────

const REAL_SCOPE =
  "The Tourism Board of Barbados seeks a creative agency to develop and execute a " +
  "social media strategy and digital marketing campaign for the 2026 visitor season. " +
  "The scope of work includes content strategy, graphic design, community management, " +
  "and monthly reporting. Proposals must include case studies and a proposed timeline.";

const PURSUE = "PURSUE";
const CONSIDER = "CONSIDER";
const SKIP = "SKIP";

// ── SKIP recommendation ───────────────────────────────────────────────────────

describe("evaluateCrawlerEligibility — SKIP recommendation", () => {
  test("SKIP with full-scope description → raw_only", () => {
    const r = evaluateCrawlerEligibility({
      title:          "RFP: Social Media Strategy for Tourism Board",
      description:    REAL_SCOPE,
      recommendation: SKIP,
    });
    assert.equal(r.eligible, false);
    assert.equal(r.destination, "raw_only");
    assert.ok(r.rejectionReasons.some((x) => x.includes("SKIP")));
  });

  test("SKIP is stored in discoveredTenders but never promoted — content quality is still assessed", () => {
    const r = evaluateCrawlerEligibility({
      title:          "Procurement of Medical Supplies",
      description:    "Supply of pharmaceutical drugs and medical equipment.",
      recommendation: SKIP,
    });
    assert.equal(r.eligible, false);
    assert.equal(r.destination, "raw_only");
    // contentQuality still classified even for SKIP records
    assert.ok(["boilerplate", "title_only", "partial_scope", "full_scope"].includes(r.contentQuality));
  });
});

// ── PURSUE + eligible → "new" ─────────────────────────────────────────────────

describe("evaluateCrawlerEligibility — PURSUE → new", () => {
  test("PURSUE with explicit phrases and full scope → eligible, destination=new", () => {
    const r = evaluateCrawlerEligibility({
      title:          "Request for Proposals: Social Media Strategy and Digital Marketing Campaign",
      description:    REAL_SCOPE,
      recommendation: PURSUE,
    });
    assert.equal(r.eligible, true);
    assert.equal(r.destination, "new");
    assert.ok(r.positiveSignals.length > 0);
    assert.equal(r.rejectionReasons.length, 0);
  });

  test("PURSUE with 'public relations' phrase → eligible", () => {
    const r = evaluateCrawlerEligibility({
      title:          "Public Relations and Communications Services",
      description:
        "The Ministry of Tourism seeks a firm to provide public relations and media relations " +
        "services for the upcoming national tourism campaign. Scope includes press release distribution, " +
        "journalist relations, and stakeholder communications over a 12-month period.",
      recommendation: PURSUE,
    });
    assert.equal(r.eligible, true);
    assert.equal(r.destination, "new");
  });
});

// ── CONSIDER + eligible → "reviewing" ────────────────────────────────────────

describe("evaluateCrawlerEligibility — CONSIDER → reviewing", () => {
  test("CONSIDER with explicit phrases → eligible, destination=reviewing", () => {
    const r = evaluateCrawlerEligibility({
      title:          "Communications Plan Development — CARICOM Secretariat",
      description:
        "The CARICOM Secretariat invites proposals for the development of a regional " +
        "communications plan and stakeholder communications strategy. The consultant will " +
        "produce a 3-year framework document and an awareness campaign rollout schedule.",
      recommendation: CONSIDER,
    });
    assert.equal(r.eligible, true);
    assert.equal(r.destination, "reviewing");
  });
});

// ── Expired deadline ──────────────────────────────────────────────────────────

describe("evaluateCrawlerEligibility — expired deadline", () => {
  test("Past deadline → raw_only regardless of recommendation or content", () => {
    const r = evaluateCrawlerEligibility({
      title:          "RFP: Brand Strategy for National Bank",
      description:    REAL_SCOPE,
      recommendation: PURSUE,
      deadline:       new Date("2020-01-01"),
    });
    assert.equal(r.eligible, false);
    assert.equal(r.destination, "raw_only");
    assert.ok(r.rejectionReasons.some((x) => x.toLowerCase().includes("deadline")));
  });

  test("Future deadline does not trigger expiry rejection", () => {
    const future = new Date();
    future.setFullYear(future.getFullYear() + 1);
    const r = evaluateCrawlerEligibility({
      title:          "RFP: Digital Marketing Campaign",
      description:    REAL_SCOPE,
      recommendation: PURSUE,
      deadline:       future,
    });
    // deadline is not the reason for ineligibility (if any)
    const deadlineRejection = r.rejectionReasons.some((x) => x.toLowerCase().includes("deadline"));
    assert.equal(deadlineRejection, false);
  });
});

// ── Content quality gates ─────────────────────────────────────────────────────

describe("evaluateCrawlerEligibility — content quality", () => {
  test("Title-only short description → raw_only (title_only)", () => {
    const r = evaluateCrawlerEligibility({
      title:          "CARICOM Secretariat procurement notice: Digital Marketing Services",
      description:    "CARICOM Secretariat procurement notice: Digital Marketing Services",
      recommendation: PURSUE,
    });
    assert.equal(r.eligible, false);
    assert.equal(r.contentQuality, "title_only");
    assert.equal(r.destination, "raw_only");
  });

  test("CTO adapter neutral description (new format) → title_only → not promoted", () => {
    const r = evaluateCrawlerEligibility({
      title:          "Tourism Marketing Campaign RFP",
      description:    "Caribbean Tourism Organization procurement notice: Tourism Marketing Campaign RFP",
      recommendation: PURSUE,
    });
    assert.equal(r.contentQuality, "title_only");
    assert.equal(r.eligible, false);
  });

  test("Old CTO adapter synthetic description was falsely eligible — documents the fixed bug", () => {
    // Old adapter format injected "destination marketing" into the description,
    // which caused the eligibility gate to pass on real opportunity content.
    // The FIX is in the adapter (synthetic text moved to rawData.adapterContext);
    // the eligibility function correctly evaluates "destination marketing" as a
    // positive signal when it appears in real scope text.
    const r = evaluateCrawlerEligibility({
      title:          "Tourism Promotion Tender",
      description:
        "Caribbean Tourism Organization procurement: Tourism Promotion Tender. " +
        "Tourism destination marketing and communications for the Caribbean region.",
      recommendation: PURSUE,
    });
    // Old format WAS eligible — this documents the regression risk.
    // With the adapter fix, description is now title_only, so eligible=false.
    assert.ok(
      r.positiveSignals.includes("destination marketing"),
      "destination marketing is a positive signal even in synthetic text (adapter must not inject it)",
    );
    // Content is partial_scope (not title_only) and has a positive signal → eligible
    assert.equal(r.eligible, true, "Old format: bug was here — adapter fix prevents injection");
  });

  test("Boilerplate description → raw_only (boilerplate)", () => {
    const r = evaluateCrawlerEligibility({
      title:          "Consulting Services",
      description:    "Consulting Services",
      recommendation: PURSUE,
    });
    assert.equal(r.contentQuality, "boilerplate");
    assert.equal(r.eligible, false);
  });

  test("Partial scope with positive signals → eligible when content ≥120 chars with real content", () => {
    // 'partial_scope' (120-199 chars) with positive phrases should be eligible
    const desc =
      "The agency is seeking a vendor to develop a digital marketing strategy and " +
      "content creation plan for social media channels. Deadline for submission is 30 days.";
    assert.ok(desc.length >= 120 && desc.length < 200);
    const r = evaluateCrawlerEligibility({
      title:          "Digital Marketing Strategy RFP",
      description:    desc,
      recommendation: PURSUE,
    });
    assert.equal(r.contentQuality, "partial_scope");
    assert.equal(r.eligible, true);
  });
});

// ── Hard negative categories ──────────────────────────────────────────────────

describe("evaluateCrawlerEligibility — individual hire filter", () => {
  const goodDesc =
    "UNDP invites applications from qualified individuals to provide communications " +
    "strategy and public awareness campaign support. The individual consultant will " +
    "develop a communications plan and deliver outreach materials over 6 months.";

  test("'Individual Consultant' in title → raw_only (strict, no override)", () => {
    const r = evaluateCrawlerEligibility({
      title: "Individual Consultant — Communications Strategy",
      description: goodDesc,
      recommendation: PURSUE,
    });
    assert.equal(r.eligible, false);
    assert.equal(r.destination, "raw_only");
    assert.ok(
      r.rejectionReasons.some((x) => x.toLowerCase().includes("individual hire")),
      `Expected individual-hire rejection, got: ${r.rejectionReasons.join("; ")}`,
    );
  });

  test("'National Consultant' in title → raw_only", () => {
    const r = evaluateCrawlerEligibility({
      title: "National Consultant — Media and Communications",
      description:
        "The World Bank seeks a national consultant to support media relations, " +
        "content creation, and social media management for the Jamaica Country Office. " +
        "Contract type: individual consultancy, 3 months lump sum.",
      recommendation: PURSUE,
    });
    assert.equal(r.eligible, false);
    assert.ok(r.rejectionReasons.some((x) => x.toLowerCase().includes("individual hire")));
  });

  test("'International Consultant' in title → raw_only", () => {
    const r = evaluateCrawlerEligibility({
      title: "International Consultant for Digital Communications Campaign",
      description:
        "UNDP Caribbean seeks an international consultant to lead a digital marketing " +
        "campaign across CARICOM member states. Scope includes social media strategy, " +
        "content development, and community engagement. Lump sum contract.",
      recommendation: PURSUE,
    });
    assert.equal(r.eligible, false);
    assert.ok(r.rejectionReasons.some((x) => x.toLowerCase().includes("individual hire")));
  });

  test("Individual hire in description (not title) → raw_only", () => {
    const r = evaluateCrawlerEligibility({
      title: "Communications Support — Caribbean Tourism Project",
      description:
        "The organization is seeking an individual consultant to provide communications " +
        "support for a 3-month assignment. The individual consultant will work on-site.",
      recommendation: PURSUE,
    });
    assert.equal(r.eligible, false);
    assert.ok(r.rejectionReasons.some((x) => x.toLowerCase().includes("individual hire")));
  });

  test("'Communications Consultant' title (firm-level) → still eligible", () => {
    // 'communications consultant' is a CORE_SERVICE_PHRASE for firm-level services —
    // must NOT be caught by the individual-hire filter.
    const r = evaluateCrawlerEligibility({
      title: "Communications Consultant Services",
      description:
        "The Ministry of Tourism invites proposals from qualified firms or organisations " +
        "to provide communications consultant services for the national destination marketing " +
        "campaign. Scope includes strategic communications, media relations, and brand strategy.",
      recommendation: PURSUE,
    });
    assert.equal(r.eligible, true, `Should be eligible (firm-level comms RFP): ${r.rejectionReasons.join("; ")}`);
  });

  test("'Short-term consultant' in title → raw_only", () => {
    const r = evaluateCrawlerEligibility({
      title: "Short-Term Consultant for Public Awareness Campaign",
      description:
        "IDB seeks a short-term consultant to develop and implement a public awareness " +
        "campaign on climate resilience in the Eastern Caribbean. Individual contract, 2 months.",
      recommendation: PURSUE,
    });
    assert.equal(r.eligible, false);
    assert.ok(r.rejectionReasons.some((x) => x.toLowerCase().includes("individual hire")));
  });
});

describe("evaluateCrawlerEligibility — hard negative categories", () => {
  test("Title dominated by civil works → raw_only", () => {
    const r = evaluateCrawlerEligibility({
      title:          "Civil Works for New Road Construction",
      description:
        "The Ministry of Infrastructure invites bids for the construction of a 12km road. " +
        "Scope includes excavation, grading, and asphalt laying. Contractors must provide " +
        "equipment and civil engineering expertise as specified in the ToR.",
      recommendation: PURSUE,
    });
    assert.equal(r.eligible, false);
    assert.ok(r.rejectionReasons.some((x) => x.toLowerCase().includes("civil works")));
  });

  test("Medical supplies title → raw_only", () => {
    const r = evaluateCrawlerEligibility({
      title:          "Supply of Medical Equipment and Pharmaceutical Supplies",
      description:
        "The Ministry of Health requests quotations for the procurement of medical equipment, " +
        "pharmaceutical drugs, and clinical supplies for district hospitals across the country.",
      recommendation: PURSUE,
    });
    assert.equal(r.eligible, false);
  });

  test("Hard negative title blocked unless ≥2 ONWRD deliverables in description", () => {
    const r = evaluateCrawlerEligibility({
      title:          "Security Services and Marketing Campaign",
      description:
        "The authority seeks combined security services and a full marketing campaign. " +
        "Deliverables: brand strategy, social media management, graphic design, " +
        "and on-site security guard deployment. Budget is $500,000.",
      recommendation: PURSUE,
    });
    // "security services" is in title as a hard negative, but ≥2 ONWRD deliverables
    // in the description (brand strategy, social media management, graphic design)
    // The rule: reject ONLY if descPositives < 2
    assert.equal(r.eligible, true, "Should be eligible because ≥2 ONWRD deliverables present");
  });
});

// ── Generic terms alone cannot qualify ───────────────────────────────────────

describe("evaluateCrawlerEligibility — generic terms alone do not qualify", () => {
  test("'communications' alone in body without recognised phrase → no positive signals → raw_only", () => {
    // The single word "communications" in the body does not qualify,
    // but the multi-word phrase "communications consultant" in the title now IS
    // a recognised CORE_SERVICE_PHRASE — so we use a title that avoids it.
    const r = evaluateCrawlerEligibility({
      title:          "Advisory Support Services",
      description:
        "The organization seeks a consultant to support communications activities. " +
        "The consultant will provide communications advisory services as needed. " +
        "Deliverables include regular updates and stakeholder briefings over 6 months.",
      recommendation: PURSUE,
    });
    assert.equal(r.positiveSignals.length, 0);
    assert.equal(r.eligible, false);
  });

  test("'Communications Consultant' title → recognised phrase → eligible", () => {
    // "communications consultant" is a multi-word CORE_SERVICE_PHRASE — a
    // development-sector posting with this title is a legitimate comms contract.
    const r = evaluateCrawlerEligibility({
      title:          "Communications Consultant",
      description:
        "The organization seeks a consultant to support communications activities. " +
        "The consultant will provide communications advisory services as needed. " +
        "Deliverables include regular updates and stakeholder briefings over 6 months.",
      recommendation: PURSUE,
    });
    assert.ok(r.positiveSignals.length >= 1);
    assert.equal(r.eligible, true);
  });

  test("'campaign' alone → no positive signals → raw_only", () => {
    const r = evaluateCrawlerEligibility({
      title:          "Campaign Support Services",
      description:
        "We are looking for a vendor to support our campaign activities including " +
        "outreach, engagement, and visibility work in rural communities. " +
        "The vendor must have experience in campaign management and training delivery.",
      recommendation: PURSUE,
    });
    assert.equal(r.positiveSignals.length, 0);
    assert.equal(r.eligible, false);
  });

  test("'branding' alone as single word → positive signal via word boundary", () => {
    // "rebranding" is in CORE_SERVICE_PHRASES as a single-word \b-anchored phrase
    const r = evaluateCrawlerEligibility({
      title:          "Rebranding of National Tourism Authority",
      description:
        "The National Tourism Authority invites proposals for a full rebranding exercise " +
        "including brand strategy, visual identity design, and a marketing campaign launch. " +
        "The selected firm will work with leadership over a 6-month engagement.",
      recommendation: PURSUE,
    });
    assert.ok(r.positiveSignals.includes("rebranding") || r.positiveSignals.includes("brand strategy"));
    assert.equal(r.eligible, true);
  });

  test("'tourism' and 'brand' alone without ONWRD phrases → raw_only", () => {
    const r = evaluateCrawlerEligibility({
      title:          "Tourism Brand Development",
      description:
        "This project aims to develop the tourism brand for the country. " +
        "Activities include stakeholder consultations, research, and brand workshops. " +
        "The consultant will present findings and recommendations at the end of the project.",
      recommendation: PURSUE,
    });
    // "tourism brand development" doesn't match any core phrase exactly
    // "brand strategy", "brand identity" etc. are not present
    assert.equal(r.eligible, false);
  });
});

// ── No positive signals ───────────────────────────────────────────────────────

describe("evaluateCrawlerEligibility — no positive signals", () => {
  test("Long description with no ONWRD phrases → raw_only", () => {
    const r = evaluateCrawlerEligibility({
      title:          "Capacity Building and Training Programme",
      description:
        "The organisation invites proposals for a 12-month capacity building programme. " +
        "Activities include training workshops, assessment, monitoring, and evaluation of " +
        "knowledge management systems. The consultant will produce quarterly reports and " +
        "a final evaluation document for submission to the steering committee.",
      recommendation: PURSUE,
    });
    assert.equal(r.positiveSignals.length, 0);
    assert.equal(r.eligible, false);
    assert.ok(r.rejectionReasons.some((x) => x.includes("No explicit ONWRD")));
  });
});
