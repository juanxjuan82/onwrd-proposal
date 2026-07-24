import { TenderSourceAdapter, TenderOpportunity, safeFetch, stripHtml } from "./base-adapter.js";

// EU Caribbean Development Funding — monitors EU-funded projects in the Caribbean
// requiring communications, visibility, outreach, and community engagement services.
export class EUCaribbeanAdapter implements TenderSourceAdapter {
  adapterType = "eu_caribbean";

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    const results: TenderOpportunity[] = [];

    const urls = [
      "https://www.cariforum.org/procurement",
      "https://www.cariforum.org/tenders",
      "https://www.cariforum.org/",
      "https://eulacfoundation.org/en/calls",
      "https://eulacfoundation.org/en/grants",
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
          /<a[^>]+href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
        let match;
        const seen = new Set<string>();

        const relevantTerms = [
          "communic", "visib", "awareness", "outreach", "campaign",
          "brand", "media", "engagement", "consult", "tender", "rfp",
        ];

        while ((match = linkPattern.exec(html)) !== null) {
          const href = match[1];
          const rawTitle = stripHtml(match[2], 200).trim();
          if (!rawTitle || rawTitle.length < 10) continue;

          const titleLower = rawTitle.toLowerCase();
          const hrefLower = href.toLowerCase();
          const hasSignal = relevantTerms.some((t) => titleLower.includes(t) || hrefLower.includes(t));
          if (!hasSignal) continue;

          if (seen.has(rawTitle)) continue;
          seen.add(rawTitle);

          const fullUrl = href.startsWith("http")
            ? href
            : `${new URL(url).origin}${href.startsWith("/") ? "" : "/"}${href}`;

          results.push({
            externalId: `eucari-${Buffer.from((rawTitle + href).slice(0, 40)).toString("base64").slice(0, 16)}`,
            title: rawTitle,
            organization: "EU Caribbean Development Fund",
            url: fullUrl,
            // Real scope from page fetch only — no synthetic marketing assumption
            description: `EU Caribbean funding notice: ${rawTitle}`,
            country: "Caribbean",
            sector: "Development Communications",
            rawData: {
              adapterContext:
                "EU Caribbean: development programmes often require communications, visibility and community engagement services.",
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
