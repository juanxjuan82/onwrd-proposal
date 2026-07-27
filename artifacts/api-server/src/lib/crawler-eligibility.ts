/**
 * Deterministic crawler eligibility evaluation — no AI calls.
 *
 * Applies phrase-level / word-boundary matching (not raw substring includes)
 * and hard-negative category detection to decide whether a raw discovery
 * should be promoted to a canonical Opportunity.
 *
 * Exported so it can be used from:
 *   - crawlers/index.ts  (inline promotion gate)
 *   - scripts/backfill-discoveries.ts
 *   - scripts/reconcile-crawler-opportunities.ts
 *   - tests
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type ContentQuality = "full_scope" | "partial_scope" | "title_only" | "boilerplate";
export type EligibilityDestination = "new" | "reviewing" | "raw_only";

export interface EligibilityInput {
  title: string;
  description: string;
  recommendation: string;
  deadline?: Date | string | null;
}

export interface EligibilityResult {
  eligible: boolean;
  destination: EligibilityDestination;
  contentQuality: ContentQuality;
  positiveSignals: string[];
  negativeSignals: string[];
  rejectionReasons: string[];
}

// ── High-confidence ONWRD core service phrases ────────────────────────────────
// All multi-word phrases (phrase-anchored by substring) or \b-anchored single
// words. Generic single words like "communications" or "campaign" are NOT here.
//
// The list includes both standard agency-service language AND the broader
// synonym phrases used in international procurement notices (World Bank, UNDP,
// IDB, CDB, etc.) that rarely use exact agency-brand terms.
const CORE_SERVICE_PHRASES: string[] = [
  // ── Agency / marketing service language ──────────────────────────────────
  "marketing strategy",
  "marketing campaign",
  "marketing services",
  "marketing plan",
  "communications strategy",
  "communication strategy",
  "communications campaign",
  "communications plan",
  "communications support",
  "communications consultant",
  "communications specialist",
  "communications firm",
  "communications expert",
  "communications services",
  "strategic communications",
  "public relations",
  "media relations",
  "media strategy",
  "media campaign",
  "media buying",
  "media plan",
  "media production",
  "media engagement",
  "brand strategy",
  "brand identity",
  "brand management",
  "brand refresh",
  "rebranding",
  "advertising campaign",
  "advertising services",
  "creative campaign",
  "creative services",
  "creative agency",
  "social media strategy",
  "social media management",
  "social media campaign",
  "social media content",
  "digital marketing",
  "digital communications",
  "digital campaign",
  "digital content",
  "content strategy",
  "content production",
  "content development",
  "content creation",
  "copywriting",
  "graphic design",
  "visual identity",
  "video production",
  "multimedia production",
  "audio-visual",
  "audiovisual",
  "documentary production",
  "destination marketing",
  "tourism marketing",
  "destination branding",
  "public awareness campaign",
  "public-awareness campaign",
  "awareness campaign",
  "awareness raising",
  "awareness creation",
  "visibility campaign",
  "visibility materials",
  "visibility products",
  "stakeholder communications",
  "pr campaign",
  "promotional campaign",
  "promotional materials",
  "email marketing",
  "influencer marketing",
  "community management",
  "web design",
  "website design",
  "website development",
  "publication design",
  // ── International procurement / development-sector synonyms ──────────────
  // These are how World Bank, UNDP, IDB, CDB, etc. describe the same services
  "outreach activities",
  "outreach strategy",
  "outreach campaign",
  "outreach materials",
  "outreach services",
  "outreach consultant",
  "public information",
  "public information officer",
  "public information campaign",
  "information campaign",
  "information dissemination",
  "knowledge dissemination",
  "knowledge products",
  "behavior change communication",
  "behaviour change communication",
  "behavior change",
  "behaviour change",
  "social mobilization",
  "social mobilisation",
  "community engagement",
  "community outreach",
  "advocacy campaign",
  "advocacy communications",
  "press and communications",
  "media and communications",
  "communication officer",
  "communication specialist",
  "communication consultant",
  "communication expert",
  "communication firm",
  "communication services",
  "print materials",
  "brochure design",
  "infographic design",
  "newsletter design",
  "annual report design",
  "report design",
  "exhibition design",
  "event communications",
  "radio campaign",
  "radio production",
  "sensitization campaign",
  "sensitisation campaign",
];

// ── Hard negative phrases — clearly out-of-scope categories ──────────────────
// Checked against title (with optional description fallback).
const HARD_NEGATIVE_PHRASES: string[] = [
  // Construction / civil
  "construction works", "civil works", "civil engineering", "road works",
  "road construction", "building works", "building construction",
  "infrastructure works", "structural engineering", "geotechnical survey",
  "dredging works", "excavation works", "bridge construction",
  // Engineering
  "mechanical engineering", "electrical works", "plumbing works",
  "hvac installation", "general contractor",
  // Supplies
  "supply of vehicles", "supply of equipment", "procurement of vehicles",
  "medical equipment", "medical supplies", "pharmaceutical supplies",
  "office supplies", "office furniture", "stationery supply",
  "food supply", "food procurement", "nutrition supplies",
  // IT hardware / software infrastructure
  "it hardware", "network equipment", "networking hardware",
  "software license", "software licensing", "erp implementation",
  "sap implementation", "data centre", "data center",
  // Financial / legal / audit
  "financial audit", "external audit", "statutory audit",
  "tax compliance", "accounting services", "legal services",
  "insurance brokerage",
  // Security / facilities
  "security guard", "guarding services", "security services",
  "cleaning services", "catering services",
  // Employment
  "job advertisement", "vacancy notice", "employment opportunity",
  "job posting", "we are hiring", "position available",
  "submit your cv", "submit your resume",
  // Procurement formalities (not services)
  "contract award notice", "award notice",
  "vendor registration", "supplier registration",
];

// ── Boilerplate stub patterns ─────────────────────────────────────────────────
const BOILERPLATE_PATTERNS: RegExp[] = [
  /^(procurement notice|consulting services?|individual consultant|expression of interest|request for (proposals?|quotations?)|rfp|notice of (procurement|intent))\s*[:.]?\s*$/i,
  /^\[?(no description available|n\/a|tbd|to be determined|see attached|see document)\]?\.?$/i,
  /^(opportunity|tender|contract)\s+(ref(erence)?|no\.?|number|id)[:\s]\s*[\w-]+\s*$/i,
];

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Phrase match with proper anchoring:
 * - Multi-word / hyphenated phrases → case-insensitive substring (phrase-anchored)
 * - Single words → word-boundary regex (\b…\b) to avoid partial matches
 */
function phraseMatch(text: string, phrase: string): boolean {
  const t = text.toLowerCase();
  const p = phrase.toLowerCase();
  if (p.includes(" ") || p.includes("-")) {
    return t.includes(p);
  }
  try {
    return new RegExp(`\\b${p}\\b`).test(t);
  } catch {
    return t.includes(p);
  }
}

function matchAll(text: string, phrases: string[]): string[] {
  return phrases.filter((p) => phraseMatch(text, p));
}

function classifyContentQuality(description: string, title: string): ContentQuality {
  const t = description.trim();

  // Known boilerplate stubs
  if (BOILERPLATE_PATTERNS.some((p) => p.test(t))) return "boilerplate";

  // Very short — not enough real content
  if (t.length < 120) return "title_only";

  // Description is essentially the title repeated plus a short suffix
  const safeTitle = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withoutTitle = t.replace(new RegExp(safeTitle, "gi"), "").trim();
  if (withoutTitle.length < 60) return "title_only";

  // Enough length to carry real scope information
  if (t.length >= 200) return "full_scope";

  return "partial_scope";
}

// ── Main eligibility function ─────────────────────────────────────────────────

export function evaluateCrawlerEligibility(discovery: EligibilityInput): EligibilityResult {
  const rejectionReasons: string[] = [];

  // 1. Expired deadline → immediate raw_only
  if (discovery.deadline) {
    const dl =
      discovery.deadline instanceof Date ? discovery.deadline : new Date(discovery.deadline);
    if (!isNaN(dl.getTime()) && dl < new Date()) {
      return {
        eligible: false,
        destination: "raw_only",
        contentQuality: classifyContentQuality(discovery.description, discovery.title),
        positiveSignals: [],
        negativeSignals: [],
        rejectionReasons: ["Deadline has passed — opportunity expired"],
      };
    }
  }

  // 2. SKIP recommendation → raw_only
  if (discovery.recommendation === "SKIP") {
    rejectionReasons.push("Recommendation is SKIP — relevance gate not met");
  }

  // 3. Content quality gate
  const contentQuality = classifyContentQuality(discovery.description, discovery.title);
  if (contentQuality === "boilerplate" || contentQuality === "title_only") {
    rejectionReasons.push(
      `Content quality is "${contentQuality}" — insufficient scope detail for promotion`,
    );
  }

  // 4. Build corpus from real content only (title + description; no adapter context)
  const corpus = `${discovery.title} ${discovery.description}`;

  // 5. Positive signals (explicit ONWRD core phrases)
  const positiveSignals = matchAll(corpus, CORE_SERVICE_PHRASES);

  // 6. Hard negatives
  const negativeSignals = matchAll(corpus.slice(0, 600), HARD_NEGATIVE_PHRASES);
  const titleNegatives = matchAll(discovery.title, HARD_NEGATIVE_PHRASES);

  // 7. Title dominated by hard negative: reject unless ≥2 ONWRD deliverables
  //    are explicitly named in the description body
  if (titleNegatives.length > 0) {
    const descPositives = matchAll(discovery.description, CORE_SERVICE_PHRASES);
    if (descPositives.length < 2) {
      rejectionReasons.push(
        `Title is dominated by out-of-scope category ("${titleNegatives[0]}"). ` +
          `Need ≥2 explicit ONWRD deliverables in description (found ${descPositives.length}).`,
      );
    }
  }

  // 8. Require at least one positive signal — generic terms alone cannot qualify
  if (positiveSignals.length === 0) {
    rejectionReasons.push(
      "No explicit ONWRD core service phrases found — generic terms alone do not qualify",
    );
  }

  // 9. Determine eligibility and destination
  const eligible = rejectionReasons.length === 0;

  let destination: EligibilityDestination = "raw_only";
  if (eligible) {
    destination = discovery.recommendation === "PURSUE" ? "new" : "reviewing";
  }

  return {
    eligible,
    destination,
    contentQuality,
    positiveSignals,
    negativeSignals,
    rejectionReasons,
  };
}
