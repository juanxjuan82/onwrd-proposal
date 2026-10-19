import { db } from "@workspace/db";
import {
  tenderSourcesTable,
  discoveredTendersTable,
  crawlerRunsTable,
  crawlerLockTable,
} from "@workspace/db";
import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { WorldBankAdapter } from "./world-bank.js";
import { UNGMAdapter } from "./ungm.js";
import { IDBAdapter } from "./idb.js";
import { CDBAdapter } from "./cdb.js";
import { BahamasGovAdapter } from "./bahamas-gov.js";
import { CTOAdapter } from "./cto.js";
import { CARICOMAdapter } from "./caricom.js";
import { EUCaribbeanAdapter } from "./eu-caribbean.js";
import {
  type AdapterFetchContext,
  type CrawlDiagnostic,
  type TenderSourceAdapter,
  type TenderOpportunity,
  hasGenuineDetailContent,
  mergeDocumentEvidence,
} from "./base-adapter.js";
import {
  canRefreshIncompleteDiscovery,
  mergeCrawlerRawData,
} from "./crawler-recovery.js";
import {
  Crawl4AIError,
  createCrawl4AIClient,
  getCrawl4AIConfig,
  normalizeSourceApprovedDomains,
} from "./crawl4ai-client.js";
import { promoteDiscoveredTender } from "../lib/promote-discovered-tender.js";
import { evaluateCrawlerEligibility } from "../lib/crawler-eligibility.js";
import { crawlerContentFingerprint, normalizeCrawlerUrl } from "./dedup.js";
import { tenderSearchProfilesTable } from "@workspace/db";

function getAdapter(adapterType: string): TenderSourceAdapter | null {
  switch (adapterType) {
    case "world_bank":   return new WorldBankAdapter();
    case "ungm":         return new UNGMAdapter();
    case "idb":          return new IDBAdapter();
    case "cdb":          return new CDBAdapter();
    case "bahamas_gov":  return new BahamasGovAdapter();
    case "cto":          return new CTOAdapter();
    case "caricom":      return new CARICOMAdapter();
    case "eu_caribbean": return new EUCaribbeanAdapter();
    default:             return null;
  }
}

// ── Shared scoring result type ──────────────────────────────────────────────
interface ScoringResult {
  fitScore: number;
  recommendation: string;
  reasoning: string;
  geographyScore: number;
  geoRegion: string;
  bahamasAdvantageScore: number;
  confidence: string;
}

// ── DB-backed crawl lock (prevents overlap across restarts & instances) ───────
const CRAWL_LOCK_KEY = "default";
const LOCK_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours — 2× max expected crawl duration
const INSTANCE_ID = randomUUID();

export interface SourceAdapterDefinition {
  adapterType: string;
  label: string;
  sourceType: string;
  allowedHosts: readonly string[];
  supportsBrowser: boolean;
  recommended: boolean;
  blockedReason?: string;
}

interface CrawlerSearchProfile {
  keywords: string[];
  excludedKeywords: string[];
}

function readProfileTerms(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().toLowerCase()).filter(Boolean)
      : [];
  } catch {
    // A malformed profile must not make a crawl fail or broaden eligibility.
    return [];
  }
}

export function profileMatchesOpportunity(
  opp: TenderOpportunity,
  profiles: CrawlerSearchProfile[],
): { matched: boolean; excluded: string[]; matchedKeywords: string[] } {
  const corpus = [opp.title, opp.description, opp.organization, opp.country ?? "", opp.sector ?? ""]
    .join(" ").toLowerCase();
  const anyKeywords = profiles.some((profile) => profile.keywords.length > 0);
  const matches = profiles.map((profile) => ({
    hasKeywords: profile.keywords.length > 0,
    keywords: profile.keywords.filter((term) => corpus.includes(term)),
    excluded: profile.excludedKeywords.filter((term) => corpus.includes(term)),
  }));
  const matchedKeywords = [...new Set(matches.flatMap((match) => match.keywords))];
  // Profiles are alternatives (OR), and an exclusion only applies to the
  // profile whose keywords matched it. An excluded match can therefore still
  // be accepted by another profile.
  const matched = matches.some((match) =>
    ((!anyKeywords && !match.hasKeywords && match.excluded.length === 0 &&
      profiles.some((profile) => profile.excludedKeywords.length > 0)) ||
      match.keywords.length > 0) &&
    match.excluded.length === 0);
  const excluded = [...new Set(matches.flatMap((match) => match.excluded))];
  return { matched, excluded, matchedKeywords };
}

// This is the only catalog exposed to source administration. Keeping it next
// to the adapter registry prevents the UI/API from implying support for an
// arbitrary URL or an adapter that the crawler cannot actually run.
export const SOURCE_ADAPTER_CATALOG: readonly SourceAdapterDefinition[] = [
  { adapterType: "world_bank", label: "World Bank Procurement", sourceType: "development_bank", allowedHosts: ["worldbank.org"], supportsBrowser: false, recommended: true },
  { adapterType: "ungm", label: "UNGM / UNDP Procurement", sourceType: "un", allowedHosts: ["undp.org"], supportsBrowser: false, recommended: false, blockedReason: "UNDP procurement notices are blocked because robots.txt disallows all paths. Use only an authorized official feed/API, opt-in notifications, or user-provided manual imports; do not crawl without permission." },
  { adapterType: "bahamas_gov", label: "Bahamas Government Procurement", sourceType: "government", allowedHosts: ["bahamas.gov.bs"], supportsBrowser: true, recommended: true },
  { adapterType: "caricom", label: "CARICOM Secretariat", sourceType: "regional", allowedHosts: ["caricom.org"], supportsBrowser: false, recommended: false },
  { adapterType: "idb", label: "Inter-American Development Bank", sourceType: "development_bank", allowedHosts: ["iadb.org"], supportsBrowser: false, recommended: false, blockedReason: "The current IDB web source is blocked. Verify an official authenticated API/feed replacement before reactivation." },
  { adapterType: "cdb", label: "Caribbean Development Bank", sourceType: "development_bank", allowedHosts: ["caribank.org"], supportsBrowser: false, recommended: false },
  { adapterType: "cto", label: "Caribbean Tourism Organization", sourceType: "regional", allowedHosts: ["caribtourism.com"], supportsBrowser: false, recommended: false, blockedReason: "The current CTO web source is blocked. Verify an official authenticated API/feed replacement before reactivation." },
  { adapterType: "eu_caribbean", label: "EU Caribbean Development Fund", sourceType: "development_fund", allowedHosts: ["cariforum.org"], supportsBrowser: false, recommended: false, blockedReason: "The current EU Caribbean web source is blocked. Verify an official authenticated API/feed replacement before reactivation." },
] as const;

export const CONTROLLED_CRAWL_ADAPTERS = ["ungm", "cdb", "caricom"] as const;

export function requiresControlledPilot(adapterType: string): boolean {
  return (CONTROLLED_CRAWL_ADAPTERS as readonly string[]).includes(adapterType);
}

export function getSourceAdapterDefinition(adapterType: string): SourceAdapterDefinition | undefined {
  return SOURCE_ADAPTER_CATALOG.find((definition) => definition.adapterType === adapterType);
}

export function getCrawlBlockReason(adapterType: string): string | null {
  return getSourceAdapterDefinition(adapterType)?.blockedReason ?? null;
}

export function validateSourceConfiguration(input: {
  adapterType: string;
  url: string;
  approvedDomains?: unknown;
}): { definition: SourceAdapterDefinition; domains: string[] } | { error: string } {
  const definition = getSourceAdapterDefinition(input.adapterType);
  if (!definition) return { error: "Unsupported adapter. Choose a registered crawler adapter." };

  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return { error: "Source URL must be an absolute http(s) URL." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: "Source URL must use HTTP or HTTPS." };
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!definition.allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
    return {
      error: `This adapter only supports registered ${definition.label} domains (${definition.allowedHosts.join(", ")}).`,
    };
  }
  try {
    return { definition, domains: normalizeSourceApprovedDomains(input.url, input.approvedDomains) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** @internal Exported for testing only — prefer testing behaviour through runCrawler(). */
export async function acquireCrawlLock(): Promise<boolean> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);

  // Delete any expired lock first (atomic read-then-delete not needed; races
  // are resolved by the ON CONFLICT DO NOTHING in the insert below)
  await db
    .delete(crawlerLockTable)
    .where(sql`${crawlerLockTable.lockKey} = ${CRAWL_LOCK_KEY} AND ${crawlerLockTable.expiresAt} < ${now}`);

  const result = await db
    .insert(crawlerLockTable)
    .values({ lockKey: CRAWL_LOCK_KEY, acquiredAt: now, expiresAt, instanceId: INSTANCE_ID })
    .onConflictDoNothing()
    .returning({ lockKey: crawlerLockTable.lockKey });

  return result.length > 0;
}

/** @internal Exported for testing only. */
export async function releaseCrawlLock(): Promise<void> {
  await db
    .delete(crawlerLockTable)
    .where(sql`${crawlerLockTable.lockKey} = ${CRAWL_LOCK_KEY} AND ${crawlerLockTable.instanceId} = ${INSTANCE_ID}`);
}

export async function isCrawlRunning(): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .select({ expiresAt: crawlerLockTable.expiresAt })
    .from(crawlerLockTable)
    .where(sql`${crawlerLockTable.lockKey} = ${CRAWL_LOCK_KEY} AND ${crawlerLockTable.expiresAt} > ${now}`);
  return rows.length > 0;
}

// ── Geography scoring ───────────────────────────────────────────────────────
function computeGeoScore(country?: string | null, contextText?: string): {
  geographyScore: number;
  geoRegion: string;
} {
  const text = [country ?? "", contextText ?? ""].join(" ").toLowerCase();

  const bahamasSignals = [
    "bahamas", "nassau", "freeport", "paradise island",
    "new providence", "grand bahama", "andros", "exuma", "eleuthera",
  ];
  const caribbeanSignals = [
    "caribbean", "caricom", "oecs", "west indies",
    "jamaica", "barbados", "trinidad", "tobago", "guyana", "belize",
    "suriname", "haiti", "dominican republic", "antigua", "barbuda",
    "st lucia", "st kitts", "nevis", "grenada", "dominica", "st vincent",
    "grenadines", "montserrat", "anguilla", "cayman", "turks and caicos",
    "aruba", "curacao", "sint maarten",
  ];
  const sidsSignals = [
    "small island developing", "sids", "pacific island",
    "maldives", "mauritius", "seychelles", "cape verde", "comoros",
    "fiji", "vanuatu", "samoa", "tonga", "kiribati", "micronesia",
    "atlantic caribbean",
  ];
  const latamSignals = [
    "latin america", "central america", "south america",
    "mexico", "colombia", "peru", "brazil", "ecuador", "bolivia",
    "paraguay", "uruguay", "argentina", "chile", "venezuela",
    "panama", "costa rica", "guatemala", "honduras", "el salvador",
    "nicaragua", "cuba", "puerto rico",
  ];

  for (const s of bahamasSignals) {
    if (text.includes(s)) return { geographyScore: 100, geoRegion: "bahamas" };
  }
  for (const s of caribbeanSignals) {
    if (text.includes(s)) return { geographyScore: 75, geoRegion: "caribbean" };
  }
  for (const s of sidsSignals) {
    if (text.includes(s)) return { geographyScore: 60, geoRegion: "sids" };
  }
  for (const s of latamSignals) {
    if (text.includes(s)) return { geographyScore: 35, geoRegion: "latam" };
  }
  return { geographyScore: 20, geoRegion: "global" };
}

// ── Bahamas advantage score ─────────────────────────────────────────────────
function computeBahamasAdvantage(geographyScore: number, rawSectorScore: number): number {
  const geoFactor = geographyScore / 100;
  const sectorFactor = Math.min(Math.max(rawSectorScore, 0), 100) / 100;
  return Math.round(Math.max(0, Math.min(100, (geoFactor * 0.65 + sectorFactor * 0.35) * 100)));
}

// ── Keyword-based scorer ─────────────────────────────────────────────────────
function keywordScore(opp: TenderOpportunity): ScoringResult {
  const text = [
    opp.title, opp.description, opp.sector ?? "", opp.organization, opp.country ?? "",
  ].join(" ").toLowerCase();

  if (opp.deadline) {
    const deadline = opp.deadline instanceof Date ? opp.deadline : new Date(opp.deadline);
    if (deadline < new Date()) {
      const { geographyScore, geoRegion } = computeGeoScore(opp.country, text);
      return { fitScore: 0, recommendation: "SKIP", reasoning: "Deadline has passed — tender is expired.", geographyScore, geoRegion, bahamasAdvantageScore: 0, confidence: "LOW" };
    }
  }

  const marketingGate = [
    "marketing", "communications", "branding", "brand",
    "campaign", "public relations", "advertising", "media relations",
    "digital marketing", "social media", "creative services",
    "content strategy", "communications strategy", "communications plan",
    "pr ", "rebranding", "destination marketing", "tourism marketing",
    "awareness campaign", "visibility campaign", "community engagement",
    "stakeholder communications", "digital communications",
  ];
  if (!marketingGate.some((kw) => text.includes(kw))) {
    const { geographyScore, geoRegion } = computeGeoScore(opp.country, text);
    return { fitScore: 0, recommendation: "SKIP", reasoning: "No marketing or communications terms — not a fit for ONWRD.", geographyScore, geoRegion, bahamasAdvantageScore: 0, confidence: "LOW" };
  }

  const disqualifiers = [
    "us citizen only", "u.s. citizen only",
    "must be a resident of", "registered vendor in the state of",
    "on-site weekly", "in-person attendance required at bi-weekly",
    "must hold active secret clearance", "security clearance required",
  ];
  if (disqualifiers.some((kw) => text.includes(kw))) {
    const { geographyScore, geoRegion } = computeGeoScore(opp.country, text);
    return { fitScore: 0, recommendation: "SKIP", reasoning: "Hard disqualifier matched — eligibility restricted to local/US-only vendors.", geographyScore, geoRegion, bahamasAdvantageScore: 0, confidence: "LOW" };
  }

  const { geographyScore, geoRegion } = computeGeoScore(
    opp.country, [opp.title, opp.description, opp.sector ?? ""].join(" "),
  );
  const isLocalRegion = geographyScore >= 75;
  if (!isLocalRegion) {
    const remoteIndicators = [
      "remote", "virtual delivery", "international bidders", "international firms",
      "worldwide", "global firms", "open to all", "any country",
    ];
    const multilateralOrgs = [
      "inter-american development bank", "idb", "world bank", "ibrd", "ifc",
      "united nations", "undp", "unicef", "unfpa", "unwomen", "unep",
      "european union", "eu ", "caribbean development bank", "cdb",
      "caricom", "cto", "oecs",
    ];
    const hasRemote = remoteIndicators.some((kw) => text.includes(kw));
    const isMultilateral = multilateralOrgs.some((kw) => text.includes(kw));
    if (!hasRemote && !isMultilateral) {
      return { fitScore: 0, recommendation: "SKIP", reasoning: "International RFP with no remote delivery or multilateral viability — delivery logistics not feasible.", geographyScore, geoRegion, bahamasAdvantageScore: 0, confidence: "LOW" };
    }
  }

  const geoComponent = geographyScore === 100 ? 35
    : geographyScore >= 75 ? 28
    : geographyScore >= 60 ? 20
    : geographyScore >= 35 ? 15
    : 10;

  const eliteSignals = [
    "marketing", "communications", "branding", "campaign",
    "public relations", "media relations", "media campaign", "media strategy",
    "communications campaign", "communications strategy",
    "marketing campaign", "marketing strategy", "brand strategy", "brand identity",
  ];
  const highSignals = [
    "communication strategy", "rebranding", "advertising", "pr campaign",
    "creative services", "creative agency", "content strategy", "copywriting",
    "editorial", "storytelling", "messaging", "narrative",
    "tourism", "destination marketing", "destination branding",
    "hospitality", "visitor experience", "travel promotion",
    "social media", "digital marketing", "digital communications",
    "digital campaign", "online presence", "website content", "web content",
    "video production", "multimedia", "photography", "graphic design",
    "public awareness", "awareness campaign", "community engagement",
    "stakeholder engagement", "behavior change", "outreach", "sensitization",
    "social mobilization", "advocacy", "knowledge dissemination", "visibility campaign",
  ];
  const mediumSignals = [
    "consulting", "advisory", "strategic communications",
    "communications plan", "engagement plan", "engagement strategy",
    "market research", "visibility", "documentation", "knowledge management",
  ];
  const weakSignals = [
    "capacity building", "training", "assessment", "evaluation",
    "survey", "research", "monitoring", "reporting",
  ];
  const negativeSignals = [
    "construction", "civil works", "road works", "road construction",
    "bridge", "dam", "dredging", "excavation", "drilling",
    "water supply", "sanitation", "sewage", "wastewater",
    "electricity", "power plant", "energy infrastructure", "solar panel",
    "medical equipment", "pharmaceutical", "drugs", "medicine", "health supplies",
    "office supplies", "office furniture", "stationery", "vehicles", "fleet",
    "food supply", "food procurement", "catering", "nutrition supplies",
    "cleaning services", "security services", "guard services",
    "it equipment", "hardware", "network equipment", "servers", "data center",
    "software license", "laboratory equipment", "spare parts",
    "financial audit", "external audit", "engineering consultancy",
    "technical feasibility", "structural engineering", "geotechnical",
  ];

  let rawCap = 0;
  const matchedTerms: string[] = [];
  let hasHighSignal = false;

  for (const kw of eliteSignals) {
    if (text.includes(kw)) { rawCap += 8; matchedTerms.push(kw.trim()); hasHighSignal = true; }
  }
  for (const kw of highSignals) {
    if (text.includes(kw)) { rawCap += 5; matchedTerms.push(kw.trim()); hasHighSignal = true; }
  }
  for (const kw of mediumSignals) {
    if (text.includes(kw)) { rawCap += 3; matchedTerms.push(kw.trim()); }
  }
  if (hasHighSignal) {
    for (const kw of weakSignals) { if (text.includes(kw)) rawCap += 2; }
  }
  for (const kw of negativeSignals) { if (text.includes(kw)) rawCap -= 6; }
  const capComponent = Math.max(0, Math.min(30, rawCap));

  const industryTiers: Array<{ terms: string[]; pts: number }> = [
    { terms: ["financial services", "banking", "insurance", "fintech", "investment"], pts: 20 },
    { terms: ["tourism", "hospitality", "hotel", "resort", "travel", "visitor economy", "destination"], pts: 20 },
    { terms: ["ministry", "government", "public sector", "national authority", "state agency"], pts: 18 },
    { terms: ["ngo", "non-governmental", "nonprofit", "non-profit", "civil society", "foundation"], pts: 16 },
    { terms: ["multilateral", "idb", "world bank", "undp", "unicef", "cdb", "development bank"], pts: 16 },
    { terms: ["health", "education", "environment", "climate", "energy transition"], pts: 10 },
  ];
  let industryComponent = 5;
  for (const tier of industryTiers) {
    if (tier.terms.some((kw) => text.includes(kw))) { industryComponent = tier.pts; break; }
  }

  const scaleIndicators = ["timeline", "milestones", "deliverables", "budget", "proposal template", "scope of work", "terms of reference", "rfp", "request for proposal"];
  const scaleMatches = scaleIndicators.filter((kw) => text.includes(kw)).length;
  const scaleComponent = Math.min(15, Math.round((scaleMatches / scaleIndicators.length) * 15));

  const baseScore = geoComponent + capComponent + industryComponent + scaleComponent;

  const urgencyBoost = (() => {
    if (!opp.deadline) return 0;
    const daysLeft = (opp.deadline.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    return daysLeft <= 14 ? 5 : 0;
  })();

  const fitScore = Math.min(100, baseScore + urgencyBoost);
  const bahamasAdvantageScore = computeBahamasAdvantage(geographyScore, Math.round((capComponent / 30) * 100));
  const recommendation = fitScore >= 60 ? "PURSUE" : fitScore >= 40 ? "CONSIDER" : "SKIP";

  const hasGeoSignal = geographyScore >= 75;
  const hasSectorSignal = capComponent >= 10;
  const confidence = hasGeoSignal && hasSectorSignal ? "HIGH"
    : hasGeoSignal || hasSectorSignal ? "MEDIUM"
    : "LOW";

  const geoLabel: Record<string, string> = {
    bahamas: "🇧🇸 Bahamas", caribbean: "🌴 Caribbean",
    sids: "🏝️ SIDS", latam: "🌎 Latin America", global: "🌐 Global",
  };
  const topMatches = [...new Set(matchedTerms)].slice(0, 4);
  const reasoning = `${geoLabel[geoRegion] ?? geoRegion} (geo ${geoComponent}/35). Capabilities ${capComponent}/30. Industry ${industryComponent}/20. Scale ${scaleComponent}/15.${urgencyBoost ? ` ⏰ Urgency +${urgencyBoost}.` : ""}${topMatches.length ? ` Keywords: ${topMatches.join(", ")}.` : ""} (Keyword engine)`;

  return { fitScore, recommendation, reasoning, geographyScore, geoRegion, bahamasAdvantageScore, confidence };
}

export function scoreCrawlerOpportunity(opp: TenderOpportunity): ScoringResult {
  return keywordScore(opp);
}

// ── Boilerplate detection ────────────────────────────────────────────────────
// Synthetic descriptions generated by adapters (not real opportunity content)
// should not trigger AI scoring — the AI learns nothing useful from them.
function isBoilerplateDescription(desc: string): boolean {
  const t = desc.trim();
  // Too short to contain meaningful scope information
  if (t.length < 120) return true;
  // Common adapter-generated stub patterns
  const stubPatterns = [
    /^(procurement notice|consulting services?|individual consultant|expression of interest|request for (proposals?|quotations?)|rfp|notice of (procurement|intent))\s*[:.]?\s*$/i,
    /^\[?(no description available|n\/a|tbd|to be determined|see attached|see document)\]?\.?$/i,
    /^(opportunity|tender|contract)\s+(ref(erence)?|no\.?|number|id)[:\s]\s*[\w-]+\s*$/i,
  ];
  return stubPatterns.some((p) => p.test(t));
}

// ── Backfill promotions for existing eligible discoveries ────────────────────
// Finds all discovered_tenders that were never promoted (opportunityId IS NULL)
// and have a CONSIDER or PURSUE recommendation, then re-evaluates eligibility
// against the current rules and promotes any that now pass.
// Safe to run multiple times — promotion is idempotent (opportunityId guard inside the service).
export async function backfillPromotions(): Promise<{ evaluated: number; promoted: number; skipped: number }> {
  const items = await db
    .select()
    .from(discoveredTendersTable)
    .where(
      sql`${discoveredTendersTable.opportunityId} IS NULL
          AND ${discoveredTendersTable.recommendation} IN ('CONSIDER', 'PURSUE')`
    );

  let promoted = 0;
  let skipped = 0;

  for (const item of items) {
    const eligibility = evaluateCrawlerEligibility({
      title:          item.title,
      description:    item.description,
      recommendation: item.recommendation ?? "SKIP",
      deadline:       item.deadline,
    });

    if (eligibility.eligible) {
      try {
        const dest = eligibility.destination === "reviewing" ? "reviewing" : "new";
        await promoteDiscoveredTender(item.id, dest);
        promoted++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[backfill] promote id=${item.id} failed: ${msg.slice(0, 80)}`);
        skipped++;
      }
    } else {
      const reason = eligibility.rejectionReasons[0] ?? "ineligible";
      console.log(`[backfill] id=${item.id} still ineligible (${reason})`);
      skipped++;
    }
  }

  return { evaluated: items.length, promoted, skipped };
}

// ── Rescore all existing items with keyword engine ──────────────────────────
export async function rescoreWithKeywords(): Promise<number> {
  const items = await db.select().from(discoveredTendersTable);
  const persistedProfiles = (await db.select({
    keywords: tenderSearchProfilesTable.keywords,
    excludedKeywords: tenderSearchProfilesTable.excludedKeywords,
  }).from(tenderSearchProfilesTable).where(eq(tenderSearchProfilesTable.active, true)))
    .map((profile) => ({
      keywords: readProfileTerms(profile.keywords),
      excludedKeywords: readProfileTerms(profile.excludedKeywords),
    }))
    .filter((profile) => profile.keywords.length > 0 || profile.excludedKeywords.length > 0);
  const hasProfileKeywords = persistedProfiles.some((profile) => profile.keywords.length > 0);

  let count = 0;
  for (const item of items) {
    const opp: TenderOpportunity = {
      externalId: item.externalId ?? undefined,
      title: item.title,
      organization: item.organization,
      url: item.url ?? undefined,
      description: item.description,
      country: item.country ?? undefined,
      sector: item.sector ?? undefined,
      deadline: item.deadline ? new Date(item.deadline) : undefined,
    };
    const result = keywordScore(opp);
    const profileMatch = profileMatchesOpportunity(opp, persistedProfiles);
    if (persistedProfiles.length > 0 &&
        !profileMatch.matched && (hasProfileKeywords || profileMatch.excluded.length > 0)) {
      result.fitScore = 0;
      result.recommendation = "SKIP";
      result.confidence = "LOW";
      result.bahamasAdvantageScore = 0;
      result.reasoning = profileMatch.excluded.length > 0
        ? `Excluded by search profile keyword: ${profileMatch.excluded[0]} (deterministic profile gate)`
        : "No active tender search profile keyword matched (deterministic profile gate)";
    }
    await db.update(discoveredTendersTable).set({
      fitScore: result.fitScore,
      recommendation: result.recommendation,
      scoringReasoning: result.reasoning,
      geographyScore: result.geographyScore,
      geoRegion: result.geoRegion,
      bahamasAdvantageScore: result.bahamasAdvantageScore,
      confidence: result.confidence,
      updatedAt: new Date(),
    }).where(eq(discoveredTendersTable.id, item.id));
    count++;
  }
  return count;
}

// ── Main crawl runner ────────────────────────────────────────────────────────
export interface RunCrawlerResult {
  total: number;
  newItems: number;
  sources: number;
  aiCallCount: number;
  aiFallbackCount: number;
  quotaErrorHit: boolean;
  successfulSources: number[];
  failedSources: number[];
}

export async function runCrawler(sourceId?: number): Promise<RunCrawlerResult> {
  // DB-backed overlap prevention — atomic across restarts and instances
  const acquired = await acquireCrawlLock();
  if (!acquired) {
    throw new Error("A crawl is already in progress — skipping to prevent overlap.");
  }

  try {
    const queriedSources = sourceId
      ? await db.select().from(tenderSourcesTable).where(eq(tenderSourcesTable.id, sourceId))
      : await db.select().from(tenderSourcesTable).where(eq(tenderSourcesTable.active, true));
    if (sourceId) {
      const blocked = queriedSources[0] && getCrawlBlockReason(queriedSources[0].adapterType);
      if (blocked) throw new Error(blocked);
    }
    // Scheduled crawls are deny-by-default too. This protects deployments with
    // stale rows that predate the startup deactivation sweep.
    const sources = queriedSources.filter((source) => {
      const definition = getSourceAdapterDefinition(source.adapterType);
      return Boolean(definition && !definition.blockedReason);
    });
    const persistedProfiles = (await db.select({
      keywords: tenderSearchProfilesTable.keywords,
      excludedKeywords: tenderSearchProfilesTable.excludedKeywords,
    }).from(tenderSearchProfilesTable).where(eq(tenderSearchProfilesTable.active, true)))
      .map((profile) => ({
        keywords: readProfileTerms(profile.keywords),
        excludedKeywords: readProfileTerms(profile.excludedKeywords),
      }))
      .filter((profile) => profile.keywords.length > 0 || profile.excludedKeywords.length > 0);
    const existingDiscoveries = await db.select({
      id: discoveredTendersTable.id,
      sourceId: discoveredTendersTable.sourceId,
      externalId: discoveredTendersTable.externalId,
      opportunityId: discoveredTendersTable.opportunityId,
      status: discoveredTendersTable.status,
      title: discoveredTendersTable.title,
      organization: discoveredTendersTable.organization,
      url: discoveredTendersTable.url,
      deadline: discoveredTendersTable.deadline,
      description: discoveredTendersTable.description,
      country: discoveredTendersTable.country,
      sector: discoveredTendersTable.sector,
      rawData: discoveredTendersTable.rawData,
    }).from(discoveredTendersTable);
    const successfulSources: number[] = [];
    const failedSources: number[] = [];

    let totalFound = 0;
    let totalNew = 0;
    let crawl4aiClient: ReturnType<typeof createCrawl4AIClient> = null;
    let crawl4aiConfigError: Error | undefined;
    try {
      crawl4aiClient = createCrawl4AIClient(getCrawl4AIConfig());
    } catch (error) {
      crawl4aiConfigError = error instanceof Error ? error : new Error(String(error));
    }

    for (const source of sources) {
      const adapter = getAdapter(source.adapterType);
      if (!adapter) continue;

      const [run] = await db.insert(crawlerRunsTable).values({
        sourceId:  source.id,
        sourceConfigurationVersion: source.configurationVersion,
        startedAt: new Date(),
        status:    "running",
        aiProvider: null,
        aiModel:    null,
      }).returning();

      const diagnostics: CrawlDiagnostic[] = [];
      try {
        const browserEligible = source.adapterType === "bahamas_gov";
        const approvedDomains = getApprovedDomains(source);
        const fetchContext: AdapterFetchContext = {
          approvedDomains,
          diagnostics,
          // The source flag is the final opt-in. API adapters and disabled
          // HTML sources never receive a browser client.
          crawl4ai: browserEligible && source.browserEnabled && crawl4aiClient
            ? crawl4aiClient
            : undefined,
        };
        if (browserEligible && source.browserEnabled && crawl4aiConfigError) {
          diagnostics.push({
            code: "crawl4ai_invalid_config",
            url: source.url,
            message: crawl4aiConfigError.message,
            method: "crawl4ai",
          });
        }
        const opportunities = await adapter.fetchOpportunities(fetchContext);
        totalFound += opportunities.length;

        let newCount = 0;

        for (const opp of opportunities) {
          const canonicalUrl = opp.url ? normalizeCrawlerUrl(opp.url) : null;
          const fingerprint = crawlerContentFingerprint({
            sourceId: source.id,
            externalId: opp.externalId,
            title: opp.title,
            organization: opp.organization,
            description: opp.description,
            url: canonicalUrl,
            deadline: opp.deadline,
          });
          const existing = existingDiscoveries.find((item) =>
            crawlerContentFingerprint(item) === fingerprint ||
            (canonicalUrl && normalizeCrawlerUrl(item.url ?? "") === canonicalUrl) ||
            (opp.externalId && item.externalId === opp.externalId));
          if (existing) {
            let existingRaw = (existing.rawData && typeof existing.rawData === "object")
              ? existing.rawData as Record<string, unknown> : {};
            if (existing.opportunityId !== null) {
              const evidenceOnlyRaw = mergeDocumentEvidence(existingRaw, opp.rawData);
              if (evidenceOnlyRaw) {
                // Preserve human-edited canonical fields; only attach source
                // evidence to the discovery record linked to that opportunity.
                await db.update(discoveredTendersTable).set({
                  rawData: evidenceOnlyRaw,
                  updatedAt: new Date(),
                }).where(and(
                  eq(discoveredTendersTable.id, existing.id),
                  eq(discoveredTendersTable.opportunityId, existing.opportunityId),
                ));
                existingRaw = evidenceOnlyRaw;
                existing.rawData = evidenceOnlyRaw;
              }
            }
            // Only replace a crawler-owned incomplete description. A changed
            // description, prior decision, user edit marker, or linked
            // opportunity prevents recovery from changing the record.
            if (canRefreshIncompleteDiscovery({
              title: existing.title,
              organization: existing.organization,
              description: existing.description,
              status: existing.status,
              opportunityId: existing.opportunityId,
              deadline: existing.deadline,
              country: existing.country,
              sector: existing.sector,
              rawData: existing.rawData,
            }, opp)) {
              const refreshedDeadline = existing.deadline ?? opp.deadline ?? null;
              const refreshedOpportunity = { ...opp, deadline: refreshedDeadline ?? undefined };
              const refreshedScore = keywordScore(refreshedOpportunity);
              const refreshedProfileMatch = profileMatchesOpportunity(refreshedOpportunity, persistedProfiles);
              const hasProfileKeywords = persistedProfiles.some((profile) => profile.keywords.length > 0);
              if (persistedProfiles.length > 0 &&
                  !refreshedProfileMatch.matched &&
                  (hasProfileKeywords || refreshedProfileMatch.excluded.length > 0)) {
                refreshedScore.fitScore = 0;
                refreshedScore.recommendation = "SKIP";
                refreshedScore.confidence = "LOW";
                refreshedScore.bahamasAdvantageScore = 0;
                refreshedScore.reasoning = refreshedProfileMatch.excluded.length > 0
                  ? `Excluded by search profile keyword: ${refreshedProfileMatch.excluded[0]} (deterministic profile gate)`
                  : "No active tender search profile keyword matched (deterministic profile gate)";
              }

              const refreshedRaw = mergeCrawlerRawData(existingRaw, {
                ...(opp.rawData ?? {}),
                crawlerFingerprint: fingerprint,
                needsEnrichment: opp.rawData?.needsEnrichment === true,
                crawlerManagedSnapshot: {
                  title: existing.title,
                  organization: existing.organization,
                  description: opp.description,
                },
              });
              const [refreshed] = await db.update(discoveredTendersTable).set({
                description: opp.description,
                rawData: refreshedRaw,
                deadline: refreshedDeadline,
                fitScore: refreshedScore.fitScore,
                recommendation: refreshedScore.recommendation,
                scoringReasoning: refreshedScore.reasoning,
                geographyScore: refreshedScore.geographyScore,
                geoRegion: refreshedScore.geoRegion,
                bahamasAdvantageScore: refreshedScore.bahamasAdvantageScore,
                confidence: refreshedScore.confidence,
                updatedAt: new Date(),
              }).where(and(
                eq(discoveredTendersTable.id, existing.id),
                eq(discoveredTendersTable.status, "new"),
                isNull(discoveredTendersTable.opportunityId),
              )).returning({ id: discoveredTendersTable.id });
              if (refreshed) {
                existing.description = opp.description;
                existing.rawData = refreshedRaw;
                existing.deadline = refreshedDeadline;
              } else {
                continue;
              }

              const eligibility = evaluateCrawlerEligibility({
                title: refreshedOpportunity.title,
                description: refreshedOpportunity.description,
                recommendation: refreshedScore.recommendation,
                deadline: refreshedDeadline ?? undefined,
              });
              if (eligibility.eligible) {
                try {
                  const destination = eligibility.destination === "reviewing" ? "reviewing" : "new";
                  const promoted = await promoteDiscoveredTender(existing.id, destination);
                  existing.opportunityId = promoted.opportunityId;
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  console.warn(`[crawler] refreshed promotion id=${existing.id} failed: ${message.slice(0, 80)}`);
                }
              }
            }
            continue;
          }

          // Deduplicate by URL or stable external identifier before inserting.
          const result = keywordScore(opp);
          const profileMatch = profileMatchesOpportunity(opp, persistedProfiles);
          // No active profiles preserves the historical safe default. Once an
          // administrator saves profiles, they become a deterministic relevance
          // gate; exclusions always win over keyword matches.
          const hasProfileKeywords = persistedProfiles.some((profile) => profile.keywords.length > 0);
          if (persistedProfiles.length > 0 &&
              !profileMatch.matched && (hasProfileKeywords || profileMatch.excluded.length > 0)) {
            result.fitScore = 0;
            result.recommendation = "SKIP";
            result.confidence = "LOW";
            result.bahamasAdvantageScore = 0;
            result.reasoning = profileMatch.excluded.length > 0
              ? `Excluded by search profile keyword: ${profileMatch.excluded[0]} (deterministic profile gate)`
              : "No active tender search profile keyword matched (deterministic profile gate)";
          }
          const [discovery] = await db.insert(discoveredTendersTable).values({
            sourceId:             source.id,
            externalId:           opp.externalId ?? null,
            title:                opp.title,
            organization:         opp.organization,
            url:                  canonicalUrl,
            deadline:             opp.deadline ?? null,
            description:          opp.description,
            country:              opp.country ?? null,
            sector:               opp.sector ?? null,
            valueAmount:          opp.valueAmount ?? null,
            rawData: {
              ...(opp.rawData ?? {}),
              crawlerFingerprint: fingerprint,
              crawlerManagedSnapshot: {
                title: opp.title,
                organization: opp.organization,
                description: opp.description,
              },
            },
            status:               "new",
            fitScore:             result.fitScore,
            recommendation:       result.recommendation,
            scoringReasoning:     result.reasoning,
            geographyScore:       result.geographyScore,
            geoRegion:            result.geoRegion,
            bahamasAdvantageScore: result.bahamasAdvantageScore,
            confidence:           result.confidence,
          }).returning({ id: discoveredTendersTable.id });
          existingDiscoveries.push({
            id: discovery.id, sourceId: source.id, externalId: opp.externalId ?? null,
            title: opp.title, organization: opp.organization, url: canonicalUrl,
            deadline: opp.deadline ?? null, description: opp.description, opportunityId: null,
            status: "new",
            country: opp.country ?? null,
            sector: opp.sector ?? null,
            rawData: {
              ...(opp.rawData ?? {}),
              crawlerFingerprint: fingerprint,
              crawlerManagedSnapshot: {
                title: opp.title,
                organization: opp.organization,
                description: opp.description,
              },
            },
          });

          // Promote only eligible discoveries to canonical Opportunities.
          // SKIP, boilerplate, title-only, and hard-negative-dominated records
          // are stored in discovered_tenders for human review but not promoted.
          const eligibility = evaluateCrawlerEligibility({
            title:          opp.title,
            description:    opp.description,
            recommendation: result.recommendation,
            deadline:       opp.deadline,
          });

          if (eligibility.eligible) {
            try {
              const dest = eligibility.destination === "reviewing" ? "reviewing" : "new";
              await promoteDiscoveredTender(discovery.id, dest);
            } catch (promErr) {
              const msg = promErr instanceof Error ? promErr.message : String(promErr);
              console.warn(`[crawler] promote id=${discovery.id} failed: ${msg.slice(0, 80)}`);
            }
          } else {
            const reason = eligibility.rejectionReasons[0] ?? "ineligible";
            console.log(`[crawler] id=${discovery.id} stored, not promoted (${reason})`);
          }

          newCount++;
          totalNew++;
        }

        const completedAt = new Date();
        await db.update(crawlerRunsTable).set({
          completedAt,
          status:         "success",
          itemsFound:     opportunities.length,
          itemsNew:       newCount,
          aiCallCount:    0,
          aiFallbackCount: 0,
          aiQuotaError:   false,
          crawlMethod: getCrawlMethod(diagnostics),
          crawl4aiAttempts: diagnostics.filter((item) => item.method === "crawl4ai").length,
          crawl4aiSuccesses: diagnostics.filter((item) => item.code === "crawl4ai_success").length,
          crawlDiagnostics: diagnostics,
        }).where(eq(crawlerRunsTable.id, run.id));

        await db.update(tenderSourcesTable).set({
          lastCheckedAt:   completedAt,
          lastSuccessAt:   completedAt,
          itemsFoundCount: source.itemsFoundCount + newCount,
          updatedAt:       completedAt,
        }).where(and(
          eq(tenderSourcesTable.id, source.id),
          eq(tenderSourcesTable.configurationVersion, source.configurationVersion),
        ));
        successfulSources.push(source.id);

      } catch (err) {
        failedSources.push(source.id);
        const failureCode = crawl4aiErrorCode(err);
        diagnostics.push({
          code: failureCode,
          url: source.url,
          message: err instanceof Error ? err.message : String(err),
          method: failureCode.startsWith("crawl4ai_") ? "crawl4ai" : "direct",
        });
        await db.update(crawlerRunsTable).set({
          completedAt:    new Date(),
          status:         "failed",
          errorMessage:   String(err instanceof Error ? err.message : err),
          aiCallCount:    0,
          aiFallbackCount: 0,
          aiQuotaError:   false,
          crawlMethod: "failed",
          crawl4aiAttempts: diagnostics.filter((item) => item.method === "crawl4ai").length,
          crawl4aiSuccesses: diagnostics.filter((item) => item.code === "crawl4ai_success").length,
          crawlDiagnostics: diagnostics,
        }).where(eq(crawlerRunsTable.id, run.id));

        await db.update(tenderSourcesTable).set({
          lastCheckedAt: new Date(),
          updatedAt:     new Date(),
        }).where(and(
          eq(tenderSourcesTable.id, source.id),
          eq(tenderSourcesTable.configurationVersion, source.configurationVersion),
        ));
      }
    }

    return {
      total:          totalFound,
      newItems:       totalNew,
      sources:        sources.length,
      aiCallCount:    0,
      aiFallbackCount: 0,
      quotaErrorHit:  false,
      successfulSources,
      failedSources,
    };
  } finally {
    await releaseCrawlLock();
  }
}

// ── Seed default sources ─────────────────────────────────────────────────────

// These adapters are blocked from Replit's environment (403/404/timeout) or
// disallowed by their current robots policy.
// We always force them inactive so existing deployments are retroactively
// deactivated without needing a separate migration step.
const PERMANENTLY_BLOCKED_ADAPTERS = ["idb", "ungm", "cto", "eu_caribbean"] as const;

function getApprovedDomains(source: {
  url: string;
  approvedDomains?: unknown;
}): string[] {
  try {
    return normalizeSourceApprovedDomains(source.url, source.approvedDomains);
  } catch {
    return [];
  }
}

function getCrawlMethod(diagnostics: CrawlDiagnostic[]): string {
  const methods = new Set(diagnostics.map((item) => item.method));
  if (diagnostics.some((item) => item.code === "crawl4ai_success")) return "crawl4ai";
  if (methods.has("crawl4ai")) return "direct_fallback";
  return "direct";
}

function crawl4aiErrorCode(error: unknown): CrawlDiagnostic["code"] {
  const code = error instanceof Crawl4AIError ? error.code : undefined;
  const map: Record<string, CrawlDiagnostic["code"]> = {
    timeout: "crawl4ai_timeout",
    authentication: "crawl4ai_authentication",
    off_domain_redirect: "crawl4ai_off_domain_redirect",
    unusable_content: "crawl4ai_unusable_content",
    service_unavailable: "crawl4ai_service_unavailable",
    malformed_response: "crawl4ai_malformed_response",
    blocked: "crawl4ai_blocked",
    invalid_config: "crawl4ai_invalid_config",
    version_mismatch: "crawl4ai_version_mismatch",
    response_too_large: "crawl4ai_response_too_large",
  };
  return map[code ?? ""] ?? "direct_failed";
}

export async function seedDefaultSources(): Promise<void> {
  // Retroactive deactivation: runs on every startup, idempotent.
  // Handles upgrades where these sources were previously seeded as active=true.
  await db
    .update(tenderSourcesTable)
    .set({ active: false })
    .where(inArray(tenderSourcesTable.adapterType, PERMANENTLY_BLOCKED_ADAPTERS));

  const activePilotSources = await db.select({
    id: tenderSourcesTable.id,
    configurationVersion: tenderSourcesTable.configurationVersion,
    adapterType: tenderSourcesTable.adapterType,
  }).from(tenderSourcesTable).where(and(
    inArray(tenderSourcesTable.adapterType, ["cdb", "caricom"]),
    eq(tenderSourcesTable.active, true),
  ));
  for (const source of activePilotSources) {
    const [pilot] = await db.select({ id: crawlerRunsTable.id })
      .from(crawlerRunsTable)
      .where(and(
        eq(crawlerRunsTable.sourceId, source.id),
        eq(crawlerRunsTable.sourceConfigurationVersion, source.configurationVersion),
        eq(crawlerRunsTable.status, "success"),
        gte(crawlerRunsTable.itemsNew, 1),
      ))
      .limit(1);
    if (!pilot) {
      await db.update(tenderSourcesTable).set({ active: false })
        .where(and(
          eq(tenderSourcesTable.id, source.id),
          eq(tenderSourcesTable.configurationVersion, source.configurationVersion),
          eq(tenderSourcesTable.active, true),
        ));
    }
  }

  const existing = await db.select().from(tenderSourcesTable);
  if (existing.length > 0) {
    const existingTypes = new Set(existing.map((s) => s.adapterType));
    const newSources = [
      // active: false — caribtourism.com is unreachable (connection timeout) from Replit
      { name: "Caribbean Tourism Organization", sourceType: "regional", url: "https://www.caribtourism.com/", adapterType: "cto", active: false },
      { name: "CARICOM Secretariat", sourceType: "regional", url: "https://caricom.org/procurement-notices/", adapterType: "caricom", active: false, browserEnabled: false, approvedDomains: ["caricom.org"] },
      // active: false — cariforum.org is unreachable (connection timeout) from Replit
      { name: "EU Caribbean Development Fund", sourceType: "development_fund", url: "https://www.cariforum.org/", adapterType: "eu_caribbean", active: false },
    ];
    for (const s of newSources) {
      if (!existingTypes.has(s.adapterType)) {
        await db.insert(tenderSourcesTable).values(s);
      }
    }
    return;
  }

  // active: false sources are blocked from Replit's environment as of July 2026.
  // Adapters are preserved in code; flip active=true once API-based replacements exist.
  const defaults = [
    { name: "World Bank Procurement",           sourceType: "development_bank",  url: "https://search.worldbank.org/api/v2/procnotices",              adapterType: "world_bank",   active: true  },
    { name: "UNDP Procurement Notices",         sourceType: "un",                url: "https://procurement-notices.undp.org/",                        adapterType: "ungm",         active: false },
    { name: "Inter-American Development Bank",  sourceType: "development_bank",  url: "https://www.iadb.org/en/projects/all",                         adapterType: "idb",          active: false },
    { name: "Caribbean Development Bank",       sourceType: "development_bank",  url: "https://www.caribank.org/",                                    adapterType: "cdb",          active: false },
      { name: "Bahamas Government Procurement",   sourceType: "government",        url: "https://www.bahamas.gov.bs/wps/portal/public/gov/government/news", adapterType: "bahamas_gov", active: true, browserEnabled: true, approvedDomains: ["bahamas.gov.bs"] },
    { name: "Caribbean Tourism Organization",   sourceType: "regional",          url: "https://www.caribtourism.com/",                                adapterType: "cto",          active: false },
      { name: "CARICOM Secretariat",              sourceType: "regional",          url: "https://caricom.org/procurement-notices/",                    adapterType: "caricom",      active: false, browserEnabled: false, approvedDomains: ["caricom.org"] },
    { name: "EU Caribbean Development Fund",    sourceType: "development_fund",  url: "https://www.cariforum.org/",                                   adapterType: "eu_caribbean", active: false },
  ];

  for (const s of defaults) {
    await db.insert(tenderSourcesTable).values(s);
  }
}

// ── Seed default search profiles ─────────────────────────────────────────────
export async function seedDefaultSearchProfiles(): Promise<void> {
  const { tenderSearchProfilesTable } = await import("@workspace/db");
  const existing = await db.select().from(tenderSearchProfilesTable);
  if (existing.length > 0) return;

  const profiles = [
    {
      name: "Communications & Marketing",
      description: "Core ONWRD practice area",
      keywords: JSON.stringify(["communications", "marketing", "campaign", "branding", "media", "public awareness", "digital engagement", "stakeholder engagement", "creative", "content"]),
      excludedKeywords: JSON.stringify([]),
    },
    {
      name: "Development Sector",
      description: "NGO/multilateral comms work",
      keywords: JSON.stringify(["community engagement", "behavior change", "knowledge dissemination", "capacity building", "social impact", "awareness campaign"]),
      excludedKeywords: JSON.stringify([]),
    },
    {
      name: "Tourism & Destination",
      description: "Tourism marketing opportunities",
      keywords: JSON.stringify(["destination marketing", "tourism", "visitor experience", "brand strategy", "promotion", "hospitality"]),
      excludedKeywords: JSON.stringify([]),
    },
    {
      name: "Bahamas & Caribbean",
      description: "Geo-priority opportunities",
      keywords: JSON.stringify(["bahamas", "caribbean", "caricom", "oecs", "cdb", "cto"]),
      excludedKeywords: JSON.stringify([]),
    },
  ];

  for (const p of profiles) {
    await db.insert(tenderSearchProfilesTable).values(p);
  }
}
