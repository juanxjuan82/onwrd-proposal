import { TenderSourceAdapter, TenderOpportunity, AdapterFetchResult, FetchFn, safeFetch, stripHtml, fetchDetailDescription } from "./base-adapter.js";

// Caribbean Development Bank adapter.
//
// NOTE: caribank.org/news-and-events returns HTTP 404 as of July 2026 — the
// site appears to have restructured its URL scheme. The adapter attempts
// several known paths; if all fail the source run is marked "failed" with a
// diagnostic message. Do NOT report this source as fixed.
export class CDBAdapter implements TenderSourceAdapter {
  adapterType = "cdb";

  constructor(private fetchFn: FetchFn = safeFetch) {}

  async fetchOpportunities(): Promise<AdapterFetchResult> {
    const warnings: string[] = [];
    let requestsAttempted = 0;
    let requestsSucceeded = 0;
    const results: TenderOpportunity[] = [];

    const urls = [
      "https://www.caribank.org/news-and-events",
      "https://www.caribank.org/projects-and-operations",
      "https://www.caribank.org/",
    ];

    for (const url of urls) {
      requestsAttempted++;
      try {
        const r = await this.fetchFn(url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; TenderBot/1.0)", Accept: "text/html" },
        });
        if (!r.ok) {
          const hint = r.status === 404
            ? "path unavailable — site may have restructured"
            : `HTTP ${r.status}`;
          warnings.push(`CDB ${hint} for ${url}`);
          continue;
        }
        const html = await r.text();
        if (html.length < 500) {
          warnings.push(`CDB returned very short response for ${url}`);
          continue;
        }
        requestsSucceeded++;

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

          // Fetch the detail page for real scope content
          let description = "";
          const detail = await fetchDetailDescription(fullUrl, this.fetchFn);
          if (detail && detail.length >= 120) {
            description = detail;
          } else {
            // Fall back to title — eligibility gate marks as title_only
            description = rawTitle;
          }

          results.push({
            externalId: `cdb-${Buffer.from(rawTitle.slice(0, 40)).toString("base64").slice(0, 16)}`,
            title: rawTitle,
            organization: "Caribbean Development Bank",
            url: fullUrl,
            description,
            country: "Caribbean",
            sector: "Development Finance",
          });

          if (results.length >= 20) break;
        }

        if (results.length > 0) break;
      } catch (err) {
        warnings.push(`CDB fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (requestsAttempted > 0 && requestsSucceeded === 0) {
      throw new Error(
        `CDB: all ${requestsAttempted} request(s) failed. ` +
        `caribank.org paths returned 404/error — site may have restructured. ` +
        warnings.join("; "),
      );
    }

    return { opportunities: results, requestsAttempted, requestsSucceeded, warnings };
  }
}
