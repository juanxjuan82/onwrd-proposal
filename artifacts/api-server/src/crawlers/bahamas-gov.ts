import { TenderSourceAdapter, TenderOpportunity, safeFetch, stripHtml } from "./base-adapter.js";

const BAHAMAS_URLS = [
  "https://procure.bahamas.gov.bs/",
  "https://www.bahamas.gov.bs/wps/portal/public/Procurement",
  "https://mof.gov.bs/procurement",
];

export class BahamasGovAdapter implements TenderSourceAdapter {
  adapterType = "bahamas_gov";

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    const results: TenderOpportunity[] = [];

    for (const url of BAHAMAS_URLS) {
      try {
        const r = await safeFetch(url, { headers: { Accept: "text/html" } });
        if (!r.ok) continue;

        const html = await r.text();
        if (html.length < 500) continue;

        const linkPattern = /<a[^>]+href="([^"]*(?:procur|tender|rfp|bid|solicitat)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
        let match;
        let count = 0;

        while ((match = linkPattern.exec(html)) !== null && count < 20) {
          const href = match[1];
          const rawTitle = stripHtml(match[2], 200);
          if (!rawTitle || rawTitle.length < 8) continue;

          count++;
          results.push({
            externalId: `bah-${Buffer.from(href + rawTitle).toString("base64").slice(0, 16)}`,
            title: rawTitle,
            organization: "Government of the Bahamas",
            url: href.startsWith("http") ? href : `https://procure.bahamas.gov.bs${href}`,
            description: `Bahamas government procurement: ${rawTitle}`,
            country: "Bahamas",
            sector: "Government",
          });
        }

        if (results.length > 0) break;
      } catch { /* try next URL */ }
    }

    return results;
  }
}
