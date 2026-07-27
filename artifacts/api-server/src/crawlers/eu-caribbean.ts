import { TenderSourceAdapter, TenderOpportunity, AdapterFetchResult, safeFetch, stripHtml } from "./base-adapter.js";

export class EUCaribbeanAdapter implements TenderSourceAdapter {
  adapterType = "eu_caribbean";

  async fetchOpportunities(): Promise<AdapterFetchResult> {
    const warnings: string[] = [];
    let requestsAttempted = 0;
    let requestsSucceeded = 0;
    const results: TenderOpportunity[] = [];

    const urls = [
      "https://www.cariforum.org/procurement/",
      "https://www.cariforum.org/tenders/",
      "https://www.cariforum.org/",
    ];

    const relevantTerms = [
      "communic", "visib", "awareness", "outreach", "campaign",
      "brand", "media", "engagement", "consult", "tender", "rfp",
    ];

    for (const url of urls) {
      requestsAttempted++;
      try {
        const r = await safeFetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; TenderBot/1.0)", Accept: "text/html" },
        });
        if (!r.ok) {
          warnings.push(`EU Caribbean HTTP ${r.status} for ${url}`);
          continue;
        }
        const html = await r.text();
        if (html.length < 500) {
          warnings.push(`EU Caribbean returned very short response for ${url}`);
          continue;
        }
        requestsSucceeded++;

        const linkPattern = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        let match;
        const seen = new Set<string>();

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
            description: `EU Caribbean funding notice: ${rawTitle}`,
            country: "Caribbean",
            sector: "Development Communications",
          });

          if (results.length >= 15) break;
        }

        if (results.length > 0) break;
      } catch (err) {
        warnings.push(`EU Caribbean fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (requestsAttempted > 0 && requestsSucceeded === 0) {
      throw new Error(`EU Caribbean: all ${requestsAttempted} requests failed. ` + warnings.join("; "));
    }

    return { opportunities: results, requestsAttempted, requestsSucceeded, warnings };
  }
}
