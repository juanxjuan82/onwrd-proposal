import { TenderSourceAdapter, TenderOpportunity, safeFetch, stripHtml } from "./base-adapter.js";

// procure.bahamas.gov.bs is unreachable from this environment.
// Targets reachable Bahamas government pages for procurement/RFP announcements.
const BAHAMAS_URLS = [
  "https://www.bahamas.gov.bs/wps/portal/public/gov/government/news",
  "https://www.bahamas.gov.bs/wps/portal/public/gov/government",
  "https://mof.gov.bs/",
];

export class BahamasGovAdapter implements TenderSourceAdapter {
  adapterType = "bahamas_gov";

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    const results: TenderOpportunity[] = [];

    for (const url of BAHAMAS_URLS) {
      try {
        const r = await safeFetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; TenderBot/1.0)",
            Accept: "text/html",
          },
        });
        if (!r.ok) continue;
        const html = await r.text();
        if (html.length < 500) continue;

        const linkPattern =
          /<a[^>]+href="([^"]*(?:procur|tender|rfp|bid|solicitat|contract|grant)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
        let match;
        const seen = new Set<string>();

        while ((match = linkPattern.exec(html)) !== null) {
          const href = match[1];
          const rawTitle = stripHtml(match[2], 200);
          if (!rawTitle || rawTitle.length < 8) continue;
          if (seen.has(rawTitle)) continue;
          seen.add(rawTitle);

          const fullUrl = href.startsWith("http") ? href : `https://www.bahamas.gov.bs${href}`;

          results.push({
            externalId: `bah-${Buffer.from((href + rawTitle).slice(0, 40)).toString("base64").slice(0, 16)}`,
            title: rawTitle,
            organization: "Government of the Bahamas",
            url: fullUrl,
            description: `Bahamas government procurement: ${rawTitle}`,
            country: "Bahamas",
            sector: "Government",
          });

          if (results.length >= 15) break;
        }

        if (results.length > 0) break;
      } catch { /* try next URL */ }
    }

    return results;
  }
}
