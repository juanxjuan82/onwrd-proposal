import { db } from "@workspace/db";
import {
  tenderSourcesTable,
  discoveredTendersTable,
  crawlerRunsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";
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

// ── Keyword-based fallback scorer ───────────────────────────────────────────
function keywordScore(opp: TenderOpportunity): ScoringResult {
  const text = [
    opp.title, opp.description, opp.sector ?? "", opp.organization, opp.country ?? "",
  ].join(" ").toLowerCase();

  // ── Marketing gate — must match at least one core term or instant SKIP ──
  const marketingGate: string[] = [
    "marketing", "communications", "branding", "brand",
    "campaign", "public relations", "advertising", "media relations",
    "digital marketing", "social media", "creative services",
    "content strategy", "communications strategy", "communications plan",
    "pr ", "rebranding", "destination marketing", "tourism marketing",
    "awareness campaign", "visibility campaign", "community engagement",
    "stakeholder communications", "digital communications",
  ];
  const passesGate = marketingGate.some((kw) => text.includes(kw));
  if (!passesGate) {
    const { geographyScore, geoRegion } = computeGeoScore(opp.country, [opp.title, opp.description, opp.sector ?? ""].join(" "));
    return {
      fitScore: 0,
      recommendation: "SKIP",
      reasoning: "No marketing or communications terms found — not a fit for ONWRD.",
      geographyScore,
      geoRegion,
      bahamasAdvantageScore: 0,
      confidence: "LOW",
    };
  }

  // ── Elite signals — ONWRD's exact core services (+20 pts each) ──────────
  const eliteSignals: string[] = [
    "marketing", "communications", "branding", "campaign",
    "public relations", "media relations",
    "media campaign", "media strategy",
    "communications campaign", "communications strategy",
    "marketing campaign", "marketing strategy",
    "brand strategy", "brand identity",
  ];

  // ── High signals — strong indicators of relevant work (+12 pts each) ────
  const highSignals: string[] = [
    "communication strategy", "rebranding",
    "advertising", "pr campaign",
    "creative services", "creative agency", "content strategy", "copywriting",
    "editorial", "storytelling", "messaging", "narrative",
    "tourism", "destination marketing", "destination branding",
    "hospitality", "visitor experience", "travel promotion",
    "social media", "digital marketing", "digital communications",
    "digital campaign", "online presence", "website content", "web content",
    "video production", "multimedia", "photography", "graphic design",
    "public awareness", "awareness campaign", "community engagement",
    "stakeholder engagement", "behavior change", "outreach", "sensitization",
    "social mobilization", "advocacy", "knowledge dissemination",
    "visibility campaign",
  ];

  // Medium signals — useful but watch for false positives
  const mediumSignals: string[] = [
    "consulting", "advisory", "strategic communications",
    "communications plan", "engagement plan", "engagement strategy",
    "market research", "feasibility study",
    "visibility", "documentation", "knowledge management",
  ];

  // Reduced-weight M&E terms — only score if paired with comms terms
  const weakSignals: string[] = [
    "capacity building", "training", "assessment", "evaluation",
    "survey", "research", "monitoring", "reporting",
  ];

  // Negative signals
  const negativeSignals: string[] = [
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

  let rawSector = 0;
  const matchedTerms: string[] = [];
  let hasHighSignal = false;

  for (const kw of eliteSignals) {
    if (text.includes(kw)) {
      rawSector += 20;
      matchedTerms.push(kw.trim());
      hasHighSignal = true;
    }
  }
  for (const kw of highSignals) {
    if (text.includes(kw)) {
      rawSector += 12;
      matchedTerms.push(kw.trim());
      hasHighSignal = true;
    }
  }
  for (const kw of mediumSignals) {
    if (text.includes(kw)) {
      rawSector += 8;
      matchedTerms.push(kw.trim());
    }
  }
  // Weak signals only score if a high signal is also present
  if (hasHighSignal) {
    for (const kw of weakSignals) {
      if (text.includes(kw)) {
        rawSector += 4;
      }
    }
  }
  for (const kw of negativeSignals) {
    if (text.includes(kw)) rawSector -= 12;
  }
  rawSector = Math.max(0, Math.min(100, rawSector));

  // Geography scoring
  const { geographyScore, geoRegion } = computeGeoScore(
    opp.country,
    [opp.title, opp.description, opp.sector ?? ""].join(" "),
  );

  // Weighted formula: geography 30%, sector 70%
  const fitScore = Math.max(0, Math.min(100, Math.round(geographyScore * 0.30 + rawSector * 0.70)));
  const bahamasAdvantageScore = computeBahamasAdvantage(geographyScore, rawSector);

  // Thresholds calibrated for the weighted formula
  const recommendation = fitScore >= 60 ? "PURSUE" : fitScore >= 35 ? "CONSIDER" : "SKIP";

  // Confidence: HIGH needs both geo + sector signal; MEDIUM = one of the two
  const hasGeoSignal = geographyScore >= 75;
  const hasSectorSignal = rawSector >= 14;
  const confidence = hasGeoSignal && hasSectorSignal ? "HIGH"
    : hasGeoSignal || hasSectorSignal ? "MEDIUM"
    : "LOW";

  // Human-readable reasoning
  const geoLabel: Record<string, string> = {
    bahamas: "🇧🇸 Bahamas",
    caribbean: "🌴 Caribbean",
    sids: "🏝️ SIDS",
    latam: "🌎 Latin America",
    global: "🌐 Global",
  };
  const topMatches = [...new Set(matchedTerms)].slice(0, 4);
  const geoStr = `${geoLabel[geoRegion] ?? geoRegion} geography (${geographyScore}/100)`;
  const sectorStr = topMatches.length > 0
    ? `Matched: ${topMatches.join(", ")}`
    : "No sector keywords matched";
  const reasoning = `${geoStr}. ${sectorStr}. (Scored by keyword engine — AI unavailable.)`;

  return { fitScore, recommendation, reasoning, geographyScore, geoRegion, bahamasAdvantageScore, confidence };
}

// ── AI scoring with keyword fallback ───────────────────────────────────────
async function scoreOpportunity(opp: TenderOpportunity): Promise<ScoringResult> {
  // Apply marketing gate before spending an AI call
  const gateText = [opp.title, opp.description, opp.sector ?? "", opp.organization].join(" ").toLowerCase();
  const gateTerms = [
    "marketing", "communications", "branding", "brand",
    "campaign", "public relations", "advertising", "media relations",
    "digital marketing", "social media", "creative services",
    "content strategy", "communications strategy", "communications plan",
    "pr ", "rebranding", "destination marketing", "tourism marketing",
    "awareness campaign", "visibility campaign", "community engagement",
    "stakeholder communications", "digital communications",
  ];
  if (!gateTerms.some((kw) => gateText.includes(kw))) {
    return keywordScore(opp); // will return score 0 immediately
  }

  try {
    const completion = await openai.chat.completions.create({
      model: "gemini-2.0-flash",
      max_tokens: 600,
      messages: [
        {
          role: "system",
          content: `You evaluate procurement opportunities for ONWRD, a Bahamas-based full-service marketing and communications agency.

ONWRD specialises in: marketing campaigns, branding, communications strategy, digital marketing, social media, tourism promotion, community engagement, public awareness campaigns, stakeholder engagement, creative production, and development-sector communications.

Evaluate each opportunity on:
- Geography: Bahamas=100, Caribbean=75, SIDS=60, Latin America=35, Global=20
- Sector fit: comms/marketing/tourism/branding = high; M&E/audit/construction = low/negative

Return ONLY valid JSON:
{
  "fitScore": <0-100, weighted: geography 30% + sector 70%>,
  "recommendation": "PURSUE" | "CONSIDER" | "SKIP",
  "reasoning": "<why pursue or skip — 2 sentences max>",
  "geographyScore": <0-100>,
  "geoRegion": "bahamas" | "caribbean" | "sids" | "latam" | "global",
  "bahamasAdvantageScore": <0-100, ONWRD's local competitive edge>,
  "confidence": "HIGH" | "MEDIUM" | "LOW"
}

PURSUE ≥60, CONSIDER 35-59, SKIP <35.`,
        },
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
  } catch (err) {
    console.warn("[scoring] OpenAI unavailable, using keyword fallback:", err instanceof Error ? err.message : String(err));
    return keywordScore(opp);
  }
}

// ── Rescore all existing items ──────────────────────────────────────────────
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

// ── Main crawl runner ───────────────────────────────────────────────────────
export async function runCrawler(sourceId?: number): Promise<{
  total: number;
  newItems: number;
  sources: number;
}> {
  const sources = sourceId
    ? await db.select().from(tenderSourcesTable).where(eq(tenderSourcesTable.id, sourceId))
    : await db.select().from(tenderSourcesTable).where(eq(tenderSourcesTable.active, true));

  let totalFound = 0;
  let totalNew = 0;

  for (const source of sources) {
    const adapter = getAdapter(source.adapterType);
    if (!adapter) continue;

    const [run] = await db.insert(crawlerRunsTable).values({
      sourceId: source.id,
      startedAt: new Date(),
      status: "running",
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

        const result = await scoreOpportunity(opp);

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
      }).where(eq(crawlerRunsTable.id, run.id));

      await db.update(tenderSourcesTable).set({
        lastCheckedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(tenderSourcesTable.id, source.id));
    }
  }

  return { total: totalFound, newItems: totalNew, sources: sources.length };
}

// ── Seed default sources ────────────────────────────────────────────────────
export async function seedDefaultSources(): Promise<void> {
  const existing = await db.select().from(tenderSourcesTable);
  if (existing.length > 0) {
    // Add any new sources that weren't there before
    const existingTypes = new Set(existing.map((s) => s.adapterType));
    const newSources = [
      {
        name: "Caribbean Tourism Organization",
        sourceType: "regional",
        url: "https://www.caribtourism.com/",
        adapterType: "cto",
      },
      {
        name: "CARICOM Secretariat",
        sourceType: "regional",
        url: "https://caricom.org/",
        adapterType: "caricom",
      },
      {
        name: "EU Caribbean Development Fund",
        sourceType: "development_fund",
        url: "https://www.cariforum.org/",
        adapterType: "eu_caribbean",
      },
    ];
    for (const s of newSources) {
      if (!existingTypes.has(s.adapterType)) {
        await db.insert(tenderSourcesTable).values({ ...s, active: true });
      }
    }
    return;
  }

  // Fresh seed — all 8 sources
  const defaults = [
    {
      name: "World Bank Procurement",
      sourceType: "development_bank",
      url: "https://search.worldbank.org/api/v2/procnotices",
      adapterType: "world_bank",
    },
    {
      name: "UNDP Procurement Notices",
      sourceType: "un",
      url: "https://procurement-notices.undp.org/",
      adapterType: "ungm",
    },
    {
      name: "Inter-American Development Bank",
      sourceType: "development_bank",
      url: "https://www.iadb.org/en/projects/all",
      adapterType: "idb",
    },
    {
      name: "Caribbean Development Bank",
      sourceType: "development_bank",
      url: "https://www.caribank.org/",
      adapterType: "cdb",
    },
    {
      name: "Bahamas Government Procurement",
      sourceType: "government",
      url: "https://www.bahamas.gov.bs/wps/portal/public/gov/government/news",
      adapterType: "bahamas_gov",
    },
    {
      name: "Caribbean Tourism Organization",
      sourceType: "regional",
      url: "https://www.caribtourism.com/",
      adapterType: "cto",
    },
    {
      name: "CARICOM Secretariat",
      sourceType: "regional",
      url: "https://caricom.org/",
      adapterType: "caricom",
    },
    {
      name: "EU Caribbean Development Fund",
      sourceType: "development_fund",
      url: "https://www.cariforum.org/",
      adapterType: "eu_caribbean",
    },
  ];

  for (const s of defaults) {
    await db.insert(tenderSourcesTable).values({ ...s, active: true });
  }
}

// ── Seed default search profiles ────────────────────────────────────────────
export async function seedDefaultSearchProfiles(): Promise<void> {
  const { tenderSearchProfilesTable } = await import("@workspace/db");
  const existing = await db.select().from(tenderSearchProfilesTable);
  if (existing.length > 0) return;

  const profiles = [
    {
      name: "Communications & Marketing",
      description: "Core ONWRD practice area",
      keywords: JSON.stringify([
        "communications", "marketing", "campaign", "branding", "media",
        "public awareness", "digital engagement", "stakeholder engagement",
        "creative", "content",
      ]),
      excludedKeywords: JSON.stringify([]),
    },
    {
      name: "Development Sector",
      description: "NGO/multilateral comms work",
      keywords: JSON.stringify([
        "community engagement", "behavior change", "knowledge dissemination",
        "capacity building", "social impact", "awareness campaign",
      ]),
      excludedKeywords: JSON.stringify([]),
    },
    {
      name: "Tourism & Destination",
      description: "Tourism marketing opportunities",
      keywords: JSON.stringify([
        "destination marketing", "tourism", "visitor experience",
        "brand strategy", "promotion", "hospitality",
      ]),
      excludedKeywords: JSON.stringify([]),
    },
    {
      name: "Bahamas & Caribbean",
      description: "Geo-priority opportunities",
      keywords: JSON.stringify([
        "bahamas", "caribbean", "caricom", "oecs", "cdb", "cto",
      ]),
      excludedKeywords: JSON.stringify([]),
    },
  ];

  for (const p of profiles) {
    await db.insert(tenderSearchProfilesTable).values(p);
  }
}
