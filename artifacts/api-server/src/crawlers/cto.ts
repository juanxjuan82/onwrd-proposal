import { TenderSourceAdapter, TenderOpportunity, safeFetch, stripHtml } from "./base-adapter.js";

// NOTE: As of July 2026, caribtourism.com is unreachable (connection timeout)
// from Replit's environment. This source is set active=false in the DB.
// The adapter is preserved for reactivation when the site becomes accessible.
export class CTOAdapter implements TenderSourceAdapter {
  adapterType = "cto";

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    const results: TenderOpportunity[] = [];
    const warnings: string[] = [];
    let requestsAttempted = 0;
    let requestsSucceeded = 0;

    const urls = [
      "https://www.caribtourism.com/procurement",
      "https://www.caribtourism.com/tenders",
      "https://www.caribtourism.com/news",
      "https://www.caribtourism.com/",
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
          warnings.push(`CTO HTTP ${r.status} for ${url}`);
          continue;
        }
        const html = await r.text();
        if (html.length < 500) {
          warnings.push(`CTO very short response for ${url}`);
          continue;
        }
        requestsSucceeded++;

        const linkPattern =
          /<a[^>]+href="([^"]*(?:procur|tender|rfp|bid|contract|consult|market|campaign|brand|tourism)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
        let match;
        const seen = new Set<string>();

        while ((match = linkPattern.exec(html)) !== null) {
          const href = match[1];
          const rawTitle = stripHtml(match[2], 200).trim();
          if (!rawTitle || rawTitle.length < 8) continue;
          if (seen.has(rawTitle)) continue;
          seen.add(rawTitle);

          const fullUrl = href.startsWith("http") ? href : `https://www.caribtourism.com${href}`;

          results.push({
            externalId: `cto-${Buffer.from(rawTitle.slice(0, 40)).toString("base64").slice(0, 16)}`,
            title: rawTitle,
            organization: "Caribbean Tourism Organization",
            url: fullUrl,
            description: `Caribbean Tourism Organization procurement notice: ${rawTitle}`,
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

    // Throw so the crawler records a failed source run rather than a silent zero-result success.
    if (requestsAttempted > 0 && requestsSucceeded === 0) {
      throw new Error(
        `CTO: all ${requestsAttempted} request(s) failed. ` +
        `caribtourism.com is unreachable from this environment (connection timeout). ` +
        warnings.join("; "),
      );
    }

    return results;
  }
}
