import { db } from "@workspace/db";
import {
  tenderSourcesTable,
  discoveredTendersTable,
  crawlerRunsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { openai, AI_MODEL } from "@workspace/integrations-openai-ai-server";
import { WorldBankAdapter } from "./world-bank.js";
import { UNGMAdapter } from "./ungm.js";
import { IDBAdapter } from "./idb.js";
import { CDBAdapter } from "./cdb.js";
import { BahamasGovAdapter } from "./bahamas-gov.js";
import { CTOAdapter } from "./cto.js";
import { CARICOMAdapter } from "./caricom.js";
import { EUCaribbeanAdapter } from "./eu-caribbean.js";
import { type TenderSourceAdapter, type TenderOpportunity } from "./base-adapter.js";

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

// ── Constants ───────────────────────────────────────────────────────────────
const AI_PROVIDER = "openai";
const AI_CAP_PER_CRAWL = 20;

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

// ── Per-crawl telemetry & circuit-breaker state ─────────────────────────────
interface CrawlTelemetry {
  aiCallCount: number;
  aiFallbackCount: number;
  quotaCircuitOpen: boolean;
  quotaErrorHit: boolean;
}

// ── In-process crawl lock (prevents overlap between scheduled & manual) ─────
let crawlInProgress = false;

export function isCrawlRunning(): boolean {
  return crawlInProgress;
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

// ── Error classifiers ────────────────────────────────────────────────────────
function isQuotaError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err);
  return msg.includes("insufficient_quota") || msg.includes("exceeded your current quota");
}

function isTemporaryRateLimitError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err);
  return (msg.includes("rate_limit") || msg.includes("rate limit") || msg.includes("too many requests"))
    && !isQuotaError(err);
}

// ── AI scorer system prompt ──────────────────────────────────────────────────
const SCORER_SYSTEM_PROMPT = `You evaluate procurement opportunities for ONWRD, a Bahamas-based full-service marketing and communications agency.

ONWRD specialises in: marketing campaigns, branding, communications strategy, digital marketing, social media, tourism promotion, community engagement, public awareness campaigns, stakeholder engagement, creative production, and development-sector communications.

Score each opportunity using this 4-component rubric (total 100 points):

1. GEOGRAPHIC ALIGNMENT (max 35 pts)
   - Bahamas: 35 | Caribbean: 28 | SIDS: 20 | Latin America: 15 | Global (multilateral/remote): 10

2. CORE CAPABILITIES (max 30 pts)
   - How well does the scope match: marketing, branding, communications strategy, PR, digital, social media, creative production?
   - Strong match = 25-30 | Moderate = 15-24 | Weak = 5-14 | None = 0

3. INDUSTRY VERTICAL (max 20 pts)
   - Financial services or Tourism/Hospitality: 20 | Government/Ministry: 18 | NGO/Multilateral: 16 | Health/Education/Climate: 10 | Other: 5

4. SCALE & FEASIBILITY (max 15 pts)
   - Are timeline, milestones, deliverables, budget, or scope clearly defined? More structure = higher score.

DISQUALIFY (return fitScore 0, SKIP) if:
- No marketing/communications terms at all
- Restricted to US-only or local-registered vendors
- International with no remote delivery or multilateral backing

Return ONLY valid JSON:
{
  "fitScore": <sum of 4 components, 0-100>,
  "recommendation": "PURSUE" | "CONSIDER" | "SKIP",
  "reasoning": "<2 sentences: key strength and any concern>",
  "geographyScore": <raw geo score: bahamas=100, caribbean=75, sids=60, latam=35, global=20>,
  "geoRegion": "bahamas" | "caribbean" | "sids" | "latam" | "global",
  "bahamasAdvantageScore": <0-100, ONWRD's competitive edge given local presence>,
  "confidence": "HIGH" | "MEDIUM" | "LOW"
}

PURSUE ≥60, CONSIDER 40-59, SKIP <40.`;

// ── Core AI call (single attempt — retries handled by scoreOpportunity) ──────
async function callAIScorer(opp: TenderOpportunity): Promise<ScoringResult> {
  const completion = await openai.chat.completions.create({
    model: AI_MODEL,
    max_tokens: 600,
    messages: [
      { role: "system", content: SCORER_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Title: ${opp.title}\nOrganization: ${opp.organization}\nCountry: ${opp.country ?? ""}\nSector: ${opp.sector ?? ""}\nDescription: ${opp.description.slice(0, 500)}`,
      },
    ],
    response_format: { type: "json_object" },
  });

  const raw = JSON.parse(completion.choices[0]?.message?.content ?? "{}");
  return {
    fitScore: Number(raw.fitScore ?? 0),
    recommendation: String(raw.recommendation ?? "SKIP"),
    reasoning: String(raw.reasoning ?? ""),
    geographyScore: Number(raw.geographyScore ?? 20),
    geoRegion: String(raw.geoRegion ?? "global"),
    bahamasAdvantageScore: Number(raw.bahamasAdvantageScore ?? 0),
    confidence: String(raw.confidence ?? "LOW"),
  };
}

// ── Score opportunity with circuit-breaker and selective retry ───────────────
//
// Rules:
//  1. Keyword scores first — SKIP immediately without any AI call.
//  2. Boilerplate descriptions are not sent to AI (keyword result returned as-is).
//  3. Circuit open (quota exhausted) or cap reached → keyword result returned.
//  4. Temporary rate-limit → retry up to 2 times with backoff.
//  5. Quota error → open circuit, no retry, keyword fallback for rest of crawl.
//  6. Any other error → keyword fallback, circuit stays closed.
async function scoreOpportunity(
  opp: TenderOpportunity,
  telemetry: CrawlTelemetry,
): Promise<ScoringResult> {
  // Step 1: Keyword scoring (always runs first, zero cost)
  const keyResult = keywordScore(opp);

  // Step 2: Hard SKIP — keyword engine is confident, no AI needed
  if (keyResult.recommendation === "SKIP") return keyResult;

  // Step 3: Boilerplate guard — synthetic descriptions don't help the AI
  if (isBoilerplateDescription(opp.description)) {
    telemetry.aiFallbackCount++;
    return {
      ...keyResult,
      reasoning: keyResult.reasoning + " (keyword-only: description too short or synthetic)",
    };
  }

  // Step 4: Circuit open or per-crawl cap reached — skip AI
  if (telemetry.quotaCircuitOpen || telemetry.aiCallCount >= AI_CAP_PER_CRAWL) {
    telemetry.aiFallbackCount++;
    return keyResult;
  }

  // Step 5: Attempt AI with rate-limit retry (quota errors never retried)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await callAIScorer(opp);
      telemetry.aiCallCount++;
      return result;
    } catch (err) {
      if (isQuotaError(err)) {
        // Open circuit immediately — don't retry, keyword for rest of crawl
        telemetry.quotaCircuitOpen = true;
        telemetry.quotaErrorHit = true;
        telemetry.aiFallbackCount++;
        console.warn("[scoring] Quota exhausted — circuit open, keyword scoring for remainder of crawl");
        return keyResult;
      }
      if (isTemporaryRateLimitError(err) && attempt < 2) {
        const delay = (attempt + 1) * 3000;
        console.warn(`[scoring] Rate limited (attempt ${attempt + 1}/3) — retrying in ${delay}ms`);
        await new Promise<void>((r) => setTimeout(r, delay));
        continue;
      }
      // Unknown error — fallback, circuit stays closed
      console.warn("[scoring] AI error, using keyword fallback:", err instanceof Error ? err.message : String(err));
      telemetry.aiFallbackCount++;
      return keyResult;
    }
  }

  // Retries exhausted (rate-limit) — fallback
  telemetry.aiFallbackCount++;
  return keyResult;
}

// ── Rescore all existing items with keyword engine ──────────────────────────
export async function rescoreWithKeywords(): Promise<number> {
  const items = await db.select().from(discoveredTendersTable);

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
export async function runCrawler(sourceId?: number): Promise<{
  total: number;
  newItems: number;
  sources: number;
  aiCallCount: number;
  aiFallbackCount: number;
  quotaErrorHit: boolean;
}> {
  // Overlap prevention — reject if a crawl is already running
  if (crawlInProgress) {
    throw new Error("A crawl is already in progress — skipping to prevent overlap.");
  }
  crawlInProgress = true;

  const telemetry: CrawlTelemetry = {
    aiCallCount: 0,
    aiFallbackCount: 0,
    quotaCircuitOpen: false,
    quotaErrorHit: false,
  };

  const sources = sourceId
    ? await db.select().from(tenderSourcesTable).where(eq(tenderSourcesTable.id, sourceId))
    : await db.select().from(tenderSourcesTable).where(eq(tenderSourcesTable.active, true));

  let totalFound = 0;
  let totalNew = 0;

  try {
    for (const source of sources) {
      const adapter = getAdapter(source.adapterType);
      if (!adapter) continue;

      // Snapshot telemetry before processing this source so per-source deltas can be recorded
      const aiCallsBefore = telemetry.aiCallCount;
      const aiFallbackBefore = telemetry.aiFallbackCount;

      const [run] = await db.insert(crawlerRunsTable).values({
        sourceId: source.id,
        startedAt: new Date(),
        status: "running",
        aiProvider: AI_PROVIDER,
        aiModel: AI_MODEL,
      }).returning();

      try {
        const opportunities = await adapter.fetchOpportunities();
        totalFound += opportunities.length;

        let newCount = 0;

        for (const opp of opportunities) {
          // Deduplicate by externalId
          if (opp.externalId) {
            const existing = await db.select({ id: discoveredTendersTable.id })
              .from(discoveredTendersTable)
              .where(eq(discoveredTendersTable.externalId, opp.externalId));
            if (existing.length > 0) continue;
          }

          // Deduplicate by URL
          if (opp.url) {
            const existingByUrl = await db.select({ id: discoveredTendersTable.id })
              .from(discoveredTendersTable)
              .where(eq(discoveredTendersTable.url, opp.url));
            if (existingByUrl.length > 0) continue;
          }

          const result = await scoreOpportunity(opp, telemetry);

          await db.insert(discoveredTendersTable).values({
            sourceId: source.id,
            externalId: opp.externalId ?? null,
            title: opp.title,
            organization: opp.organization,
            url: opp.url ?? null,
            deadline: opp.deadline ?? null,
            description: opp.description,
            country: opp.country ?? null,
            sector: opp.sector ?? null,
            valueAmount: opp.valueAmount ?? null,
            rawData: opp.rawData ?? null,
            status: "new",
            fitScore: result.fitScore,
            recommendation: result.recommendation,
            scoringReasoning: result.reasoning,
            geographyScore: result.geographyScore,
            geoRegion: result.geoRegion,
            bahamasAdvantageScore: result.bahamasAdvantageScore,
            confidence: result.confidence,
          });

          newCount++;
          totalNew++;
        }

        await db.update(crawlerRunsTable).set({
          completedAt: new Date(),
          status: "success",
          itemsFound: opportunities.length,
          itemsNew: newCount,
          aiCallCount: telemetry.aiCallCount - aiCallsBefore,
          aiFallbackCount: telemetry.aiFallbackCount - aiFallbackBefore,
          aiQuotaError: telemetry.quotaErrorHit,
        }).where(eq(crawlerRunsTable.id, run.id));

        await db.update(tenderSourcesTable).set({
          lastCheckedAt: new Date(),
          lastSuccessAt: new Date(),
          itemsFoundCount: source.itemsFoundCount + newCount,
          updatedAt: new Date(),
        }).where(eq(tenderSourcesTable.id, source.id));

      } catch (err) {
        await db.update(crawlerRunsTable).set({
          completedAt: new Date(),
          status: "failed",
          errorMessage: String(err instanceof Error ? err.message : err),
          aiCallCount: telemetry.aiCallCount - aiCallsBefore,
          aiFallbackCount: telemetry.aiFallbackCount - aiFallbackBefore,
          aiQuotaError: telemetry.quotaErrorHit,
        }).where(eq(crawlerRunsTable.id, run.id));

        await db.update(tenderSourcesTable).set({
          lastCheckedAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(tenderSourcesTable.id, source.id));
      }
    }
  } finally {
    crawlInProgress = false;
  }

  return {
    total: totalFound,
    newItems: totalNew,
    sources: sources.length,
    aiCallCount: telemetry.aiCallCount,
    aiFallbackCount: telemetry.aiFallbackCount,
    quotaErrorHit: telemetry.quotaErrorHit,
  };
}

// ── Seed default sources ─────────────────────────────────────────────────────
export async function seedDefaultSources(): Promise<void> {
  const existing = await db.select().from(tenderSourcesTable);
  if (existing.length > 0) {
    const existingTypes = new Set(existing.map((s) => s.adapterType));
    const newSources = [
      { name: "Caribbean Tourism Organization", sourceType: "regional", url: "https://www.caribtourism.com/", adapterType: "cto" },
      { name: "CARICOM Secretariat", sourceType: "regional", url: "https://caricom.org/", adapterType: "caricom" },
      { name: "EU Caribbean Development Fund", sourceType: "development_fund", url: "https://www.cariforum.org/", adapterType: "eu_caribbean" },
    ];
    for (const s of newSources) {
      if (!existingTypes.has(s.adapterType)) {
        await db.insert(tenderSourcesTable).values({ ...s, active: true });
      }
    }
    return;
  }

  const defaults = [
    { name: "World Bank Procurement", sourceType: "development_bank", url: "https://search.worldbank.org/api/v2/procnotices", adapterType: "world_bank" },
    { name: "UNDP Procurement Notices", sourceType: "un", url: "https://procurement-notices.undp.org/", adapterType: "ungm" },
    { name: "Inter-American Development Bank", sourceType: "development_bank", url: "https://www.iadb.org/en/projects/all", adapterType: "idb" },
    { name: "Caribbean Development Bank", sourceType: "development_bank", url: "https://www.caribank.org/", adapterType: "cdb" },
    { name: "Bahamas Government Procurement", sourceType: "government", url: "https://www.bahamas.gov.bs/wps/portal/public/gov/government/news", adapterType: "bahamas_gov" },
    { name: "Caribbean Tourism Organization", sourceType: "regional", url: "https://www.caribtourism.com/", adapterType: "cto" },
    { name: "CARICOM Secretariat", sourceType: "regional", url: "https://caricom.org/", adapterType: "caricom" },
    { name: "EU Caribbean Development Fund", sourceType: "development_fund", url: "https://www.cariforum.org/", adapterType: "eu_caribbean" },
  ];

  for (const s of defaults) {
    await db.insert(tenderSourcesTable).values({ ...s, active: true });
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
