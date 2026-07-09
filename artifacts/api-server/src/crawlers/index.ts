import { db } from "@workspace/db";
import {
  tenderSourcesTable,
  discoveredTendersTable,
  crawlerRunsTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";
import { WorldBankAdapter } from "./world-bank.js";
import { UNGMAdapter } from "./ungm.js";
import { IDBAdapter } from "./idb.js";
import { CDBAdapter } from "./cdb.js";
import { BahamasGovAdapter } from "./bahamas-gov.js";
import { type TenderSourceAdapter, type TenderOpportunity } from "./base-adapter.js";

function getAdapter(adapterType: string): TenderSourceAdapter | null {
  switch (adapterType) {
    case "world_bank": return new WorldBankAdapter();
    case "ungm": return new UNGMAdapter();
    case "idb": return new IDBAdapter();
    case "cdb": return new CDBAdapter();
    case "bahamas_gov": return new BahamasGovAdapter();
    default: return null;
  }
}

async function scoreOpportunity(opp: TenderOpportunity): Promise<{
  fitScore: number;
  recommendation: string;
  reasoning: string;
}> {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_completion_tokens: 500,
      messages: [
        {
          role: "system",
          content: `You evaluate procurement opportunities for ONWRD, a full-service marketing and communications agency based in the Bahamas. ONWRD specialises in: marketing campaigns, branding, communications strategy, digital marketing, social media, tourism promotion, community engagement, public awareness campaigns, stakeholder engagement, creative production, and development-sector communications.

Score this opportunity 0-100 for ONWRD relevance. Return JSON only: {"fitScore": number, "recommendation": "PURSUE"|"CONSIDER"|"SKIP", "reasoning": "1-2 sentence explanation"}

High scores (70+): marketing/comms/branding/digital/media/tourism/public awareness
Medium scores (40-69): consulting/engagement work adjacent to comms
Low scores (<40): construction, IT infrastructure, supply procurement, unrelated sectors`,
        },
        {
          role: "user",
          content: `Title: ${opp.title}\nOrganization: ${opp.organization}\nSector: ${opp.sector ?? ""}\nCountry: ${opp.country ?? ""}\nDescription: ${opp.description.slice(0, 400)}`,
        },
      ],
      response_format: { type: "json_object" },
    });

    const raw = JSON.parse(completion.choices[0]?.message?.content ?? "{}");
    return {
      fitScore: Number(raw.fitScore ?? 0),
      recommendation: String(raw.recommendation ?? "SKIP"),
      reasoning: String(raw.reasoning ?? ""),
    };
  } catch {
    return { fitScore: 0, recommendation: "SKIP", reasoning: "Scoring failed" };
  }
}

export async function runCrawler(sourceId?: number): Promise<{
  total: number;
  newItems: number;
  sources: number;
}> {
  const query = db.select().from(tenderSourcesTable).where(eq(tenderSourcesTable.active, true));
  const sources = sourceId
    ? await db.select().from(tenderSourcesTable).where(
        and(eq(tenderSourcesTable.id, sourceId), eq(tenderSourcesTable.active, true))
      )
    : await query;

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
        const existing = opp.externalId
          ? await db.select({ id: discoveredTendersTable.id })
              .from(discoveredTendersTable)
              .where(eq(discoveredTendersTable.externalId, opp.externalId))
          : [];

        if (existing.length > 0) continue;

        if (opp.url) {
          const existingByUrl = await db.select({ id: discoveredTendersTable.id })
            .from(discoveredTendersTable)
            .where(eq(discoveredTendersTable.url, opp.url));
          if (existingByUrl.length > 0) continue;
        }

        const { fitScore, recommendation, reasoning } = await scoreOpportunity(opp);

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
          fitScore,
          recommendation,
          scoringReasoning: reasoning,
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

export async function seedDefaultSources(): Promise<void> {
  const existing = await db.select().from(tenderSourcesTable);
  if (existing.length > 0) return;

  const defaults = [
    { name: "World Bank Procurement", sourceType: "development_bank", url: "https://search.worldbank.org/api/v2/procurement", adapterType: "world_bank" },
    { name: "UN Global Marketplace (UNGM)", sourceType: "un", url: "https://www.ungm.org/Public/Notice", adapterType: "ungm" },
    { name: "Inter-American Development Bank", sourceType: "development_bank", url: "https://www.iadb.org/en/project-procurement", adapterType: "idb" },
    { name: "Caribbean Development Bank", sourceType: "development_bank", url: "https://www.caribank.org/procurement", adapterType: "cdb" },
    { name: "Bahamas Government Procurement", sourceType: "government", url: "https://procure.bahamas.gov.bs/", adapterType: "bahamas_gov" },
  ];

  for (const s of defaults) {
    await db.insert(tenderSourcesTable).values(s);
  }
}

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
      keywords: JSON.stringify(["community engagement", "behavior change", "knowledge management", "capacity building", "social impact", "MEL", "monitoring evaluation"]),
      excludedKeywords: JSON.stringify([]),
    },
    {
      name: "Tourism & Destination",
      description: "Tourism marketing opportunities",
      keywords: JSON.stringify(["destination marketing", "tourism", "visitor experience", "brand strategy", "promotion", "hospitality"]),
      excludedKeywords: JSON.stringify([]),
    },
  ];

  for (const p of profiles) {
    await db.insert(tenderSearchProfilesTable).values(p);
  }
}
