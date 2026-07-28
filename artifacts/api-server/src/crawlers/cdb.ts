import { TenderSourceAdapter, TenderOpportunity, safeFetch, stripHtml } from "./base-adapter.js";

// NOTE: As of July 2026, caribank.org has restructured its URLs — all known
// paths return 404. This source is set active=false in the DB. The adapter is
// preserved for reactivation once correct URLs are found.
export class CDBAdapter implements TenderSourceAdapter {
  adapterType = "cdb";

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    const results: TenderOpportunity[] = [];
    const warnings: string[] = [];
    let requestsAttempted = 0;
    let requestsSucceeded = 0;

    const urls = [
      "https://www.caribank.org/news-and-events",
      "https://www.caribank.org/projects-and-operations",
      "https://www.caribank.org/",
    ];

    for (const url of urls) {
      requestsAttempted++;
      try {
        const r = await safeFetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; TenderBot/1.0)",
            Accept: "text/html",
          },
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
          warnings.push(`CDB very short response for ${url}`);
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
      } catch (err) {
        warnings.push(`CDB fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Throw so the crawler records a failed source run rather than a silent zero-result success.
    if (requestsAttempted > 0 && requestsSucceeded === 0) {
      throw new Error(
        `CDB: all ${requestsAttempted} request(s) failed. ` +
        `caribank.org paths returned 404/error — site may have restructured. ` +
        warnings.join("; "),
      );
    }

    return results;
  }
}
