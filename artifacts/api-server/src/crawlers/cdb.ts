import { TenderSourceAdapter, TenderOpportunity, safeFetch, stripHtml } from "./base-adapter.js";

// caribank.org/procurement returns 404. This adapter targets CDB's news/projects
// page for procurement-adjacent announcements, and falls back to press releases.
export class CDBAdapter implements TenderSourceAdapter {
  adapterType = "cdb";

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    const results: TenderOpportunity[] = [];

    const urls = [
      "https://www.caribank.org/news-and-events",
      "https://www.caribank.org/projects-and-operations",
      "https://www.caribank.org/",
    ];

    for (const url of urls) {
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

        // Look for article/card links mentioning procurement, tender, consulting, RFP
        const linkPattern =
          /<a[^>]+href="([^"]*(?:procur|tender|rfp|consult|bid|contract|grant|project)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
        let match;
        const seen = new Set<string>();

        while ((match = linkPattern.exec(html)) !== null) {
          const href = match[1];
          const rawTitle = stripHtml(match[2], 200);
          if (!rawTitle || rawTitle.length < 10) continue;
          if (seen.has(rawTitle)) continue;
          seen.add(rawTitle);

          const fullUrl = href.startsWith("http") ? href : `https://www.caribank.org${href}`;

          results.push({
            externalId: `cdb-${Buffer.from(rawTitle.slice(0, 40)).toString("base64").slice(0, 16)}`,
            title: rawTitle,
            organization: "Caribbean Development Bank",
            url: fullUrl,
            description: `Caribbean Development Bank announcement: ${rawTitle}`,
            country: "Caribbean",
            sector: "Development Finance",
          });

          if (results.length >= 20) break;
        }

        if (results.length > 0) break;
      } catch { /* try next */ }
    }

    return results;
  }
}
