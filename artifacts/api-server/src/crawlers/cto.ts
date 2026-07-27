import { TenderSourceAdapter, TenderOpportunity, AdapterFetchResult, safeFetch, stripHtml } from "./base-adapter.js";

// Caribbean Tourism Organization — destination marketing, tourism promotion,
// branding and comms work across the Caribbean region.
export class CTOAdapter implements TenderSourceAdapter {
  adapterType = "cto";

  async fetchOpportunities(): Promise<AdapterFetchResult> {
    const warnings: string[] = [];
    let requestsAttempted = 0;
    let requestsSucceeded = 0;
    const results: TenderOpportunity[] = [];

    const urls = [
      "https://www.caribtourism.com/procurement",
      "https://www.caribtourism.com/tenders",
      "https://www.caribtourism.com/news",
      "https://www.caribtourism.com/",
    ];

    for (const url of urls) {
      requestsAttempted++;
      try {
        const r = await safeFetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; TenderBot/1.0)", Accept: "text/html" },
        });
        if (!r.ok) {
          warnings.push(`CTO HTTP ${r.status} for ${url}`);
          continue;
        }
        const html = await r.text();
        if (html.length < 500) {
          warnings.push(`CTO returned very short response for ${url}`);
          continue;
        }
        requestsSucceeded++;

        const linkPattern =
          /<a[^>]+href="([^"]*(?:procur|tender|rfp|bid|contract|consult|market|campaign|brand|tourism)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
        let match;
        const seen = new Set<string>();

        while ((match = linkPattern.exec(html)) !== null) {
          const href = match[1];
          const rawTitle = stripHtml(match[2], 200).trim();
          if (!rawTitle || rawTitle.length < 8) continue;
          if (seen.has(rawTitle)) continue;
          seen.add(rawTitle);

          const fullUrl = href.startsWith("http") ? href : `https://www.caribtourism.com${href}`;

          results.push({
            externalId: `cto-${Buffer.from(rawTitle.slice(0, 40)).toString("base64").slice(0, 16)}`,
            title: rawTitle,
            organization: "Caribbean Tourism Organization",
            url: fullUrl,
            description: `Caribbean Tourism Organization procurement notice: ${rawTitle}`,
            country: "Caribbean",
            sector: "Tourism & Destination Marketing",
          });

          if (results.length >= 20) break;
        }

        if (results.length > 0) break;
      } catch (err) {
        warnings.push(`CTO fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (requestsAttempted > 0 && requestsSucceeded === 0) {
      throw new Error(`CTO: all ${requestsAttempted} requests failed. ` + warnings.join("; "));
    }

    return { opportunities: results, requestsAttempted, requestsSucceeded, warnings };
  }
}
