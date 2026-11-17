import { TenderSourceAdapter, TenderOpportunity, safeFetch, stripHtml, stableId, absoluteUrl } from "./base-adapter.js";

// EU Caribbean Development Funding — monitors EU-funded projects in the Caribbean
// requiring communications, visibility, outreach, and community engagement services.
export class EUCaribbeanAdapter implements TenderSourceAdapter {
  adapterType = "eu_caribbean";

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    const results: TenderOpportunity[] = [];
    let lastError: Error | undefined;
    let okPages = 0;

    const urls = [
      "https://www.cariforum.org/procurement",
      "https://www.cariforum.org/tenders",
      "https://www.cariforum.org/",
      // EU-LAC Foundation's real tenders/calls page (verified Nov 2026).
      "https://eulacfoundation.org/en/opportunities/tenders",
    ];

    for (const url of urls) {
      try {
        const r = await safeFetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; TenderBot/1.0)",
            Accept: "text/html",
          },
        });
        if (!r.ok) { lastError = new Error(`${url} answered HTTP ${r.status}`); continue; }
        const html = await r.text();
        if (html.length < 500) { lastError = new Error(`${url} returned an empty page`); continue; }
        okPages++;

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
          // Skip calls the page itself marks as finished.
          if (/\bclosed\b|\bresults\b/i.test(rawTitle)) continue;

          const titleLower = rawTitle.toLowerCase();
          const hrefLower = href.toLowerCase();
          const hasSignal = relevantTerms.some((t) => titleLower.includes(t) || hrefLower.includes(t));
          if (!hasSignal) continue;
          // Must look like an actual call/tender, not a menu or blog link.
          if (!/\bcall\b|tender|expression of interest|consultan|request for|procure|terms of reference/i.test(`${rawTitle} ${hrefLower}`)) continue;
          if (/^(tenders?|opportunities|procurement)$/i.test(rawTitle)) continue;

          if (seen.has(rawTitle)) continue;
          seen.add(rawTitle);

          const fullUrl = absoluteUrl(href, url);

          results.push({
            externalId: stableId("eucari", fullUrl),
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
      } catch (err) { lastError = err instanceof Error ? err : new Error(String(err)); }
    }

    // No listing page could be loaded at all — report it rather than look "empty".
    if (okPages === 0 && lastError) throw lastError;
    return results;
  }
}
