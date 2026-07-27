import { TenderSourceAdapter, TenderOpportunity, AdapterFetchResult, FetchFn, safeFetch, stripHtml, fetchDetailDescription } from "./base-adapter.js";

// Caribbean Tourism Organization adapter.
//
// NOTE: caribtourism.com is unreachable (connection timeout) from this
// environment as of July 2026. The adapter is kept active so that
// fixture-based tests exercise the real parsing path. Do NOT report this
// source as fixed; live data is unavailable from Replit.
//
// Link matching is broadened to anchor text, not just URL keywords, so that
// procurement notices posted under generic paths are still captured.
export class CTOAdapter implements TenderSourceAdapter {
  adapterType = "cto";

  constructor(private fetchFn: FetchFn = safeFetch) {}

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

    // Relevant terms to match in anchor text OR href
    const relevantTerms = [
      "procur", "tender", "rfp", "bid", "contract", "consult",
      "market", "campaign", "brand", "tourism", "communic", "agency",
    ];

    for (const url of urls) {
      requestsAttempted++;
      try {
        const r = await this.fetchFn(url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; TenderBot/1.0)", Accept: "text/html" },
        });
        if (!r.ok) {
          const hint = r.status === 0 || !r.status
            ? "site unreachable (connection timeout) from this environment"
            : `HTTP ${r.status}`;
          warnings.push(`CTO ${hint} for ${url}`);
          continue;
        }
        const html = await r.text();
        if (html.length < 500) {
          warnings.push(`CTO returned very short response for ${url}`);
          continue;
        }
        requestsSucceeded++;

        // Match links by URL keyword OR by anchor text containing relevant terms
        const linkPattern = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        let match;
        const seen = new Set<string>();

        while ((match = linkPattern.exec(html)) !== null) {
          const href = match[1];
          const rawTitle = stripHtml(match[2], 200).trim();
          if (!rawTitle || rawTitle.length < 8) continue;

          const titleLower = rawTitle.toLowerCase();
          const hrefLower = href.toLowerCase();
          const hasSignal = relevantTerms.some((t) => titleLower.includes(t) || hrefLower.includes(t));
          if (!hasSignal) continue;

          if (seen.has(rawTitle)) continue;
          seen.add(rawTitle);

          const fullUrl = href.startsWith("http") ? href : `https://www.caribtourism.com${href}`;

          // Fetch detail page for real scope content
          let description = "";
          const detail = await fetchDetailDescription(fullUrl, this.fetchFn);
          if (detail && detail.length >= 120) {
            description = detail;
          } else {
            // Fall back to title — eligibility gate marks as title_only
            description = rawTitle;
          }

          results.push({
            externalId: `cto-${Buffer.from(rawTitle.slice(0, 40)).toString("base64").slice(0, 16)}`,
            title: rawTitle,
            organization: "Caribbean Tourism Organization",
            url: fullUrl,
            description,
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
      throw new Error(
        `CTO: all ${requestsAttempted} request(s) failed. ` +
        `caribtourism.com is unreachable from this environment (connection timeout). ` +
        warnings.join("; "),
      );
    }

    return { opportunities: results, requestsAttempted, requestsSucceeded, warnings };
  }
}
