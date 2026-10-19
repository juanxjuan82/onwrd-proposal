import {
  TenderSourceAdapter,
  TenderOpportunity,
  AdapterFetchContext,
  extractDeadline,
  fetchTenderDetailWithOptionalBrowser,
  resolveNoticeUrl,
  safeFetch,
  stripHtml,
} from "./base-adapter.js";

// Uses CDB's public procurement-notices listing; the older news/project pages
// remain fallbacks. The source stays inactive by default pending a controlled pilot.
export class CDBAdapter implements TenderSourceAdapter {
  adapterType = "cdb";

  async fetchOpportunities(context?: AdapterFetchContext): Promise<TenderOpportunity[]> {
    const results: TenderOpportunity[] = [];
    const warnings: string[] = [];
    let requestsAttempted = 0;
    let requestsSucceeded = 0;

    const urls = [
      "https://www.caribank.org/work-with-us/procurement/procurement-notices",
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

          const fullUrl = resolveNoticeUrl(href, url, context?.approvedDomains ?? ["caribank.org"]);
          if (!fullUrl) continue;
          if (new URL(url).pathname.startsWith("/work-with-us/procurement/procurement-notices")) {
            const listingPath = "/work-with-us/procurement/procurement-notices";
            const noticePath = new URL(fullUrl).pathname;
            if (!noticePath.startsWith(`${listingPath}/`)) continue;
          }
          const linkPosition = html.indexOf(href, match.index ?? 0);
          const rowStart = linkPosition >= 0 ? html.lastIndexOf("<tr", linkPosition) : -1;
          const rowEnd = linkPosition >= 0 ? html.indexOf("</tr>", linkPosition) : -1;
          const listingContext = rowStart >= 0 && rowEnd > rowStart
            ? stripHtml(html.slice(rowStart, rowEnd + 5), 1_500)
            : rawTitle;
          const detail = await fetchTenderDetailWithOptionalBrowser(fullUrl, rawTitle, context);
          const description = detail?.content ?? listingContext;

          results.push({
            externalId: `cdb-${Buffer.from(rawTitle.slice(0, 40)).toString("base64").slice(0, 16)}`,
            title: rawTitle,
            organization: "Caribbean Development Bank",
            url: fullUrl,
            deadline: extractDeadline(description),
            description,
            country: "Caribbean",
            sector: "Development Finance",
            rawData: {
              sourcePage: url,
              listingContext,
              extractionMethod: detail ? `${detail.method}_detail` : "listing_context",
              ...(detail ? { renderedMetadata: detail.metadata } : { needsEnrichment: true }),
            },
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
