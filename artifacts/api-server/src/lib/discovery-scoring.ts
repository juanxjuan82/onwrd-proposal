/**
 * Pure deterministic keyword scorer used by both the live crawl pipeline
 * and the discovery reconciler.
 *
 * Extracted from crawlers/index.ts to break the circular import that would
 * arise if discovery-reconciler.ts imported directly from crawlers/index.ts.
 */

export interface ScoredResult {
  fitScore: number;
  recommendation: string;
  reasoning: string;
  geographyScore: number;
  geoRegion: string;
  bahamasAdvantageScore: number;
  confidence: string;
}

interface TenderInput {
  title: string;
  description: string;
  sector?: string | null;
  organization?: string;
  country?: string | null;
  deadline?: Date | null;
  url?: string | null;
}

// ── Geography scoring ─────────────────────────────────────────────────────────
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

function computeBahamasAdvantage(geographyScore: number, rawSectorScore: number): number {
  const geoFactor = geographyScore / 100;
  const sectorFactor = Math.min(Math.max(rawSectorScore, 0), 100) / 100;
  return Math.round(Math.max(0, Math.min(100, (geoFactor * 0.65 + sectorFactor * 0.35) * 100)));
}

export function scoreTender(opp: TenderInput): ScoredResult {
  const text = [
    opp.title, opp.description, opp.sector ?? "", opp.organization ?? "", opp.country ?? "",
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
    "outreach", "awareness", "sensitization", "communication officer",
    "communication consultant", "communications support",
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

  const { geographyScore, geoRegion } = computeGeoScore(opp.country, text);
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
      return { fitScore: 0, recommendation: "SKIP", reasoning: "International RFP with no remote delivery or multilateral viability.", geographyScore, geoRegion, bahamasAdvantageScore: 0, confidence: "LOW" };
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
    "market research", "visibility", "documentation",
    "communications support", "communication officer", "communication consultant",
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
