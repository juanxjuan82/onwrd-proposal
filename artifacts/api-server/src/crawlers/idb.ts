import { TenderSourceAdapter, TenderOpportunity, AdapterFetchResult, FetchFn, safeFetch, stripHtml, fetchDetailDescription } from "./base-adapter.js";

// Inter-American Development Bank adapter.
//
// NOTE: As of July 2026, iadb.org returns HTTP 403 for all server-to-server
// requests from this environment. bidsandcontracts.iadb.org is unreachable
// (connection timeout). The adapter is kept active so that:
//   (a) fixture-based tests exercise the real parsing path, and
//   (b) the source run is correctly marked "failed" with a diagnostic message
//       when the site becomes accessible or the environment changes.
//
// Do NOT report this source as fixed — live data is unavailable from Replit.
export class IDBAdapter implements TenderSourceAdapter {
  adapterType = "idb";

  constructor(private fetchFn: FetchFn = safeFetch) {}

  async fetchOpportunities(): Promise<AdapterFetchResult> {
    const warnings: string[] = [];
    let requestsAttempted = 0;
    let requestsSucceeded = 0;
    const results: TenderOpportunity[] = [];
    const seen = new Set<string>();

    const urls = [
      "https://www.iadb.org/en/projects/all?query=communications+marketing&country=BS,JM,TT,BB,GY,LC,VC",
      "https://www.iadb.org/en/projects/all?query=media+tourism+campaign&country=BS,JM,TT,BB",
    ];

    for (const url of urls) {
      requestsAttempted++;
      try {
        const r = await this.fetchFn(url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; TenderBot/1.0)", Accept: "text/html" },
        });
        if (!r.ok) {
          const hint = r.status === 403
            ? "iadb.org blocks server-to-server access from this environment"
            : `HTTP ${r.status}`;
          warnings.push(`IDB ${hint} for ${url}`);
          continue;
        }
        const html = await r.text();
        if (html.length < 500) {
          warnings.push(`IDB returned very short response (${html.length} chars) for ${url}`);
          continue;
        }
        requestsSucceeded++;

        const articlePattern = /<article[^>]*>([\s\S]*?)<\/article>/gi;
        let match;
        let count = 0;

        while ((match = articlePattern.exec(html)) !== null && count < 15) {
          const block = match[1];
          const titleMatch = block.match(/<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/i);
          const linkMatch = block.match(/href="([^"]*\/en\/project[^"]+)"/i);
          const descMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
          const title = titleMatch ? stripHtml(titleMatch[1], 200) : "";
          if (!title || title.length < 10) continue;

          const titleKey = title.toLowerCase().slice(0, 60);
          if (seen.has(titleKey)) continue;
          seen.add(titleKey);

          const href = linkMatch ? linkMatch[1] : "";
          const detailUrl = href
            ? href.startsWith("http") ? href : `https://www.iadb.org${href}`
            : "";

          // Try to fetch real scope from the project detail page
          let description = descMatch ? stripHtml(descMatch[1], 600) : "";
          if (description.length < 120 && detailUrl) {
            const detail = await fetchDetailDescription(detailUrl, this.fetchFn);
            if (detail && detail.length >= 120) {
              description = detail;
            }
          }
          // If still no substantive description, fall back to title — eligibility gate
          // will mark this title_only and store with rejectionReasons.
          if (description.length < 120) {
            description = title;
          }

          count++;
          results.push({
            externalId: `idb-${Buffer.from(title.slice(0, 40)).toString("base64").slice(0, 16)}`,
            title,
            organization: "Inter-American Development Bank",
            url: detailUrl || "https://www.iadb.org/en/projects/all",
            description,
            country: "Caribbean / Latin America",
            sector: "Development",
          });
        }

        if (results.length > 0) break;
      } catch (err) {
        warnings.push(`IDB fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (requestsAttempted > 0 && requestsSucceeded === 0) {
      throw new Error(
        `IDB: all ${requestsAttempted} request(s) failed. ` +
        `iadb.org is currently inaccessible from this environment (403 / timeout). ` +
        warnings.join("; "),
      );
    }

    return { opportunities: results, requestsAttempted, requestsSucceeded, warnings };
  }
}
