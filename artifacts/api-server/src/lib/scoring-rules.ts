/**
 * Deterministic bid-fit scoring for ONWRD — no AI calls.
 *
 * Weights and thresholds are centralised at the top of this file and
 * exported so they can be tuned and tested independently.
 */

export type FitLevel = "strong" | "moderate" | "weak" | "no_bid";

export interface TenderScoringInput {
  title:        string;
  agency:       string;
  category:     string;
  description:  string;
  deadline?:    Date | string | null;
  valueAmount?: string | null;
  rawText?:     string | null;
  contactInfo?: string | null;
}

export interface ScoringResult {
  fitScore:          number;     // 0-100
  fitLevel:          FitLevel;
  reasoning:         string;     // 1-2 sentence narrative
  flags:             string[];   // per-rule factors (shown as UI chips)
  completenessScore: number;     // 0-100
  missingFields:     string[];   // gaps that weaken the brief
}

// ── Centralized weights and thresholds ────────────────────────────────────────

export const SCORING_WEIGHTS = {
  serviceMatch: 40, // 0-40 pts — category/keyword alignment
  geography:    25, // 0-25 pts — location relevance
  completeness: 20, // 0-20 pts — brief quality bonus
  // deadline urgency: 0 to -20 pts (penalty applied after)
} as const;

export const FIT_THRESHOLDS = {
  strong:   70, // ≥ 70 → strong
  moderate: 45, // ≥ 45 → moderate
  weak:     20, // ≥ 20 → weak; < 20 → no_bid
} as const;

// ── Keyword banks ─────────────────────────────────────────────────────────────

// ONWRD's core disciplines — strong positive signal
const CORE_SERVICE_KEYWORDS = [
  "marketing", "branding", "brand identity", "brand strategy", "brand management",
  "digital marketing", "social media", "social media management",
  "communications", "communication strategy", "communications strategy",
  "campaign", "advertising", "creative agency", "public relations", " pr ",
  "content", "copywriting", "web design", "website design",
  "website development", "graphic design", "media buying",
  "community management", "email marketing", "influencer",
  "media strategy", "media plan", "communications plan",
  "promotional materials", "marketing services", "marketing strategy",
];

// Adjacent / partially relevant services
const ADJACENT_SERVICE_KEYWORDS = [
  "strategy consulting", "consulting services", "research services",
  "stakeholder", "outreach", "engagement", "awareness campaign",
  "event management", "sponsorship", "annual report", "newsletter",
  "visual identity", "photography", "videography", "filming",
  "production services", "design services", "creative services",
  "media production", "digital content",
];

// Hard exclusions — definitively outside ONWRD's scope
const EXCLUSION_KEYWORDS = [
  "construction", "civil engineering", "infrastructure works", "mechanical engineering",
  "electrical works", "plumbing", "hvac", "general contractor", "land surveying",
  "medical supplies", "pharmaceutical", "clinical services", "hospital",
  "it systems", "software development", "erp system", "sap implementation",
  "network infrastructure", "cybersecurity", "it infrastructure",
  "law enforcement", "security guard", "police", "military",
  "legal services", "audit services", "accounting services",
  "tax compliance", "insurance brokerage",
];

// Employment role signals — individual hire, not agency procurement
const EMPLOYMENT_KEYWORDS = [
  "job opening", "job opportunity", "job advertisement", "job posting",
  "vacancy", "position available", "we are hiring", "we are seeking a",
  "we are seeking an", "seeking experienced", "join our team",
  "career opportunity", "full-time position", "part-time position",
  "permanent role", "temporary role", "submit your cv", "submit your resume",
  "send your application", "equal opportunity employer", "salary range",
  "benefits package", "years experience required", "minimum qualifications",
  "job description", "key responsibilities", "reporting to the",
  "competitive salary", "annual leave",
];

// Geography: strongest first
const BAHAMAS_KEYWORDS = [
  "bahamas", "bahamian", "nassau", "freeport", "new providence", "grand bahama",
  "eleuthera", "abaco", "exuma",
];

const CARIBBEAN_KEYWORDS = [
  "caribbean", "caricom", "west indies", "barbados", "jamaica", "trinidad",
  "guyana", "belize", "antigua", "st. lucia", "st lucia", "grenada", "haiti",
  "dominican republic", "puerto rico", "cayman", "turks and caicos",
  "british virgin islands", "us virgin islands", "aruba", "curacao",
  "suriname", "montserrat", "st. kitts", "st kitts",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function lower(s: string): string { return s.toLowerCase(); }

function hasAny(haystack: string, needles: string[]): boolean {
  const h = lower(haystack);
  return needles.some((n) => h.includes(lower(n)));
}

function daysUntil(deadline: Date | string): number {
  const d = typeof deadline === "string" ? new Date(deadline) : deadline;
  return Math.ceil((d.getTime() - Date.now()) / 86_400_000);
}

// ── Completeness scoring ──────────────────────────────────────────────────────

export function calcCompleteness(input: TenderScoringInput): {
  score: number;
  missingFields: string[];
} {
  const missing: string[] = [];
  let score = 0;

  // Description quality (0-30 pts)
  const descLen = (input.description ?? "").length;
  if (descLen >= 200) {
    score += 30;
  } else if (descLen >= 50) {
    score += 15;
    missing.push("Description too brief — add more detail");
  } else {
    missing.push("Description is very short or empty");
  }

  // Deadline present (0-25 pts)
  if (input.deadline) {
    score += 25;
  } else {
    missing.push("Deadline not specified");
  }

  // Budget / value (0-25 pts)
  if (input.valueAmount && input.valueAmount.trim().length > 0) {
    score += 25;
  } else {
    missing.push("Budget / contract value not specified");
  }

  // Full RFP text (0-20 pts)
  if (input.rawText && input.rawText.trim().length > 200) {
    score += 20;
  } else {
    missing.push("Full RFP text not provided");
  }

  return { score: Math.min(100, score), missingFields: missing };
}

// ── Main scoring function ─────────────────────────────────────────────────────

export function scoreTender(input: TenderScoringInput): ScoringResult {
  const corpus = [
    input.title, input.agency, input.category,
    input.description, input.rawText ?? "",
  ].join(" ");

  const flags: string[] = [];

  // ── 0. Employment override ───────────────────────────────────────────────────
  if (hasAny(corpus, EMPLOYMENT_KEYWORDS)) {
    const { score: cs, missingFields } = calcCompleteness(input);
    return {
      fitScore: 0,
      fitLevel: "no_bid",
      reasoning:
        "This posting appears to be for an individual employment role (job vacancy / staff hire) rather than " +
        "an agency services contract. ONWRD does not bid on individual staff recruitment.",
      flags: ["Individual employment role — not an RFP for agency services"],
      completenessScore: cs,
      missingFields,
    };
  }

  // ── 1. Completeness contribution ────────────────────────────────────────────
  const { score: completenessScore, missingFields } = calcCompleteness(input);
  const completenessContrib = Math.round(
    (completenessScore / 100) * SCORING_WEIGHTS.completeness,
  );

  // ── 2. Service match (0-40 pts) ──────────────────────────────────────────────
  const hasCore      = hasAny(corpus, CORE_SERVICE_KEYWORDS);
  const hasAdjacent  = hasAny(corpus, ADJACENT_SERVICE_KEYWORDS);
  const hasExclusion = hasAny(corpus, EXCLUSION_KEYWORDS);
  let serviceScore   = 0;

  if (hasCore && !hasExclusion) {
    serviceScore = SCORING_WEIGHTS.serviceMatch;                       // 40
    flags.push("Directly in ONWRD's core service areas");
  } else if (hasCore && hasExclusion) {
    serviceScore = Math.round(SCORING_WEIGHTS.serviceMatch * 0.50);   // 20
    flags.push("Mixed scope — core marketing services alongside out-of-scope requirements");
  } else if (hasAdjacent && !hasExclusion) {
    serviceScore = Math.round(SCORING_WEIGHTS.serviceMatch * 0.55);   // 22
    flags.push("Adjacent service category — relevant but not ONWRD's core discipline");
  } else if (hasAdjacent && hasExclusion) {
    serviceScore = Math.round(SCORING_WEIGHTS.serviceMatch * 0.20);   // 8
    flags.push("Predominantly out-of-scope with minor adjacent components");
  } else if (hasExclusion) {
    serviceScore = 0;
    flags.push("Category outside ONWRD's scope (construction / technical / infrastructure)");
  } else {
    serviceScore = Math.round(SCORING_WEIGHTS.serviceMatch * 0.15);   // 6
    flags.push("Service area unclear — category not described in sufficient detail");
  }

  // ── 3. Geography (0-25 pts) ──────────────────────────────────────────────────
  let geoScore = 0;
  if (hasAny(corpus, BAHAMAS_KEYWORDS)) {
    geoScore = SCORING_WEIGHTS.geography;                              // 25
    flags.push("Bahamas — ONWRD's primary home market");
  } else if (hasAny(corpus, CARIBBEAN_KEYWORDS)) {
    geoScore = Math.round(SCORING_WEIGHTS.geography * 0.72);           // 18
    flags.push("Caribbean region — within ONWRD's operating area");
  } else {
    geoScore = Math.round(SCORING_WEIGHTS.geography * 0.20);           // 5
    flags.push("Geography not identified or outside Caribbean/Bahamas region");
  }

  // ── 4. Deadline urgency penalty (0 to -20 pts) ────────────────────────────────
  let deadlinePenalty = 0;
  if (input.deadline) {
    const days = daysUntil(input.deadline);
    if (days < 0) {
      deadlinePenalty = -20;
      flags.push("Submission deadline has already passed");
    } else if (days <= 3) {
      deadlinePenalty = -15;
      flags.push(`Deadline in ${days} day(s) — extremely urgent`);
    } else if (days <= 7) {
      deadlinePenalty = -8;
      flags.push(`Deadline in ${days} days — under one week`);
    } else if (days <= 14) {
      deadlinePenalty = -3;
      flags.push(`Deadline in ${days} days — approaching soon`);
    } else {
      flags.push(`${days} days until deadline`);
    }
  }

  // ── 5. Composite score ───────────────────────────────────────────────────────
  const raw      = serviceScore + geoScore + completenessContrib + deadlinePenalty;
  const fitScore = Math.min(100, Math.max(0, raw));

  // ── 6. Fit level ─────────────────────────────────────────────────────────────
  let fitLevel: FitLevel;
  if      (fitScore >= FIT_THRESHOLDS.strong)   fitLevel = "strong";
  else if (fitScore >= FIT_THRESHOLDS.moderate) fitLevel = "moderate";
  else if (fitScore >= FIT_THRESHOLDS.weak)     fitLevel = "weak";
  else                                           fitLevel = "no_bid";

  // ── 7. Plain-language reasoning sentence ────────────────────────────────────
  const levelWord = { strong: "strong", moderate: "moderate", weak: "weak", no_bid: "poor" }[fitLevel];
  const topFactors = flags.slice(0, 2).join("; ");
  const reasoning =
    `ONWRD has a ${levelWord} fit for this opportunity (score ${fitScore}/100). ${topFactors}.`;

  return { fitScore, fitLevel, reasoning, flags, completenessScore, missingFields };
}
