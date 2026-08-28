import { BahamasGovAdapter } from "../crawlers/bahamas-gov.js";
import { CARICOMAdapter } from "../crawlers/caricom.js";
import {
  type AdapterFetchContext,
  type CrawlDiagnostic,
  type TenderOpportunity,
  type TenderSourceAdapter,
} from "../crawlers/base-adapter.js";
import { createCrawl4AIClient, getCrawl4AIConfig } from "../crawlers/crawl4ai-client.js";

const ALLOWLIST = {
  bahamas_gov: {
    adapter: () => new BahamasGovAdapter(),
    domains: ["bahamas.gov.bs"],
  },
  caricom: {
    adapter: () => new CARICOMAdapter(),
    domains: ["caricom.org"],
  },
} as const;

type AllowlistedSource = keyof typeof ALLOWLIST;

async function runAdapter(
  adapter: TenderSourceAdapter,
  context?: AdapterFetchContext,
): Promise<{ durationMs: number; opportunities: TenderOpportunity[]; error?: string }> {
  const startedAt = Date.now();
  try {
    const opportunities = await adapter.fetchOpportunities(context);
    return {
      durationMs: Date.now() - startedAt,
      opportunities,
    };
  } catch (error) {
    return {
      durationMs: Date.now() - startedAt,
      opportunities: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function quality(opportunities: TenderOpportunity[]) {
  const descriptions = opportunities.map((item) => item.description.trim().length);
  return {
    resultCount: opportunities.length,
    descriptionsOver200: descriptions.filter((length) => length >= 200).length,
    averageDescriptionLength: descriptions.length
      ? Math.round(descriptions.reduce((sum, length) => sum + length, 0) / descriptions.length)
      : 0,
    deadlineCount: opportunities.filter((item) => item.deadline).length,
  };
}

async function main() {
  const sourceArg = process.argv.slice(2).find((arg) => arg !== "--") ?? "caricom";
  if (!(sourceArg in ALLOWLIST)) {
    throw new Error(`Probe source must be one of: ${Object.keys(ALLOWLIST).join(", ")}.`);
  }
  const source = sourceArg as AllowlistedSource;
  const definition = ALLOWLIST[source];
  const client = createCrawl4AIClient(getCrawl4AIConfig());
  if (!client) {
    throw new Error(
      "Crawl4AI is disabled. Configure CRAWL4AI_ENDPOINT, CRAWL4AI_API_KEY, and CRAWL4AI_SERVER_VERSION.",
    );
  }

  // This script does not import the database, scoring, promotion, or AI gateway.
  // It only compares adapter output in memory for one allowlisted source.
  const baseline = await runAdapter(definition.adapter());
  const diagnostics: CrawlDiagnostic[] = [];
  const enriched = await runAdapter(definition.adapter(), {
    crawl4ai: client,
    approvedDomains: definition.domains,
    diagnostics,
  });

  const report = {
    source,
    baseline: { ...quality(baseline.opportunities), durationMs: baseline.durationMs, error: baseline.error },
    enriched: { ...quality(enriched.opportunities), durationMs: enriched.durationMs, error: enriched.error },
    diagnostics,
    materiallyImproved:
      quality(enriched.opportunities).descriptionsOver200 > quality(baseline.opportunities).descriptionsOver200 ||
      quality(enriched.opportunities).deadlineCount > quality(baseline.opportunities).deadlineCount ||
      quality(enriched.opportunities).resultCount > quality(baseline.opportunities).resultCount,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.materiallyImproved) process.exitCode = 2;
}

await main();