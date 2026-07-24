import { TenderSourceAdapter, TenderOpportunity, safeFetch, stripHtml } from "./base-adapter.js";

// CARICOM Secretariat — monitors regional communications, public awareness,
// stakeholder engagement and policy communications across the Caribbean Community.
export class CARICOMAdapter implements TenderSourceAdapter {
  adapterType = "caricom";

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    const results: TenderOpportunity[] = [];

    const urls = [
      "https://caricom.org/procurement-notices",
      "https://caricom.org/procurement",
      "https://caricom.org/tenders",
      "https://caricom.org/news-and-media",
      "https://caricom.org/",
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

        const linkPattern =
          /<a[^>]+href="([^"]*(?:procur|tender|rfp|bid|consult|communic|campaign|awareness|engagement)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
        let match;
        const seen = new Set<string>();

        while ((match = linkPattern.exec(html)) !== null) {
          const href = match[1];
          const rawTitle = stripHtml(match[2], 200).trim();
          if (!rawTitle || rawTitle.length < 8) continue;
          if (seen.has(rawTitle)) continue;
          seen.add(rawTitle);

          const fullUrl = href.startsWith("http") ? href : `https://caricom.org${href}`;

          results.push({
            externalId: `caricom-${Buffer.from(rawTitle.slice(0, 40)).toString("base64").slice(0, 16)}`,
            title: rawTitle,
            organization: "CARICOM Secretariat",
            url: fullUrl,
            // Real scope from page fetch only — no synthetic marketing assumption
            description: `CARICOM Secretariat procurement notice: ${rawTitle}`,
            country: "Caribbean",
            sector: "Government & Public Communications",
            rawData: {
              adapterContext:
                "CARICOM procurement: regional Caribbean Community communications and public awareness work.",
            },
          });

          if (results.length >= 15) break;
        }

        if (results.length > 0) break;
      } catch { /* try next URL */ }
    }

    return results;
  }
}
