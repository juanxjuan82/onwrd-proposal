import { TenderSourceAdapter, TenderOpportunity, safeFetch, stripHtml } from "./base-adapter.js";

// NOTE: As of July 2026, iadb.org returns HTTP 403 for all server-to-server
// requests from Replit's environment. This source is set active=false in the DB.
// The adapter is preserved so fixture-based tests can exercise the parsing path
// and so the source can be reactivated if a proper API becomes available.
export class IDBAdapter implements TenderSourceAdapter {
  adapterType = "idb";

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    const results: TenderOpportunity[] = [];
    const warnings: string[] = [];
    let requestsAttempted = 0;
    let requestsSucceeded = 0;

    const urls = [
      "https://www.iadb.org/en/projects/all?query=communications+marketing&country=BS,JM,TT,BB,GY,LC,VC",
      "https://www.iadb.org/en/projects/all?query=media+tourism+campaign&country=BS,JM,TT,BB",
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
          const hint = r.status === 403
            ? "iadb.org blocks server-to-server access from this environment (403)"
            : `HTTP ${r.status}`;
          warnings.push(`IDB ${hint} for ${url}`);
          continue;
        }
        const html = await r.text();
        if (html.length < 500) {
          warnings.push(`IDB very short response for ${url}`);
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
          const title = titleMatch ? stripHtml(titleMatch[1], 200) : "";
          if (!title || title.length < 10) continue;

          const href = linkMatch ? linkMatch[1] : "";
          count++;
          results.push({
            externalId: `idb-${Buffer.from(title.slice(0, 40)).toString("base64").slice(0, 16)}`,
            title,
            organization: "Inter-American Development Bank",
            url: href
              ? href.startsWith("http") ? href : `https://www.iadb.org${href}`
              : "https://www.iadb.org/en/projects/all",
            description: `IDB project: ${title}`,
            country: "Caribbean / Latin America",
            sector: "Development",
          });
        }

        if (results.length > 0) break;
      } catch (err) {
        warnings.push(`IDB fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Throw so the crawler records a failed source run rather than a silent zero-result success.
    if (requestsAttempted > 0 && requestsSucceeded === 0) {
      throw new Error(
        `IDB: all ${requestsAttempted} request(s) failed. ` +
        `iadb.org is inaccessible from this environment (403/timeout). ` +
        warnings.join("; "),
      );
    }

    return results;
  }
}
