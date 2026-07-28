import { TenderSourceAdapter, TenderOpportunity, safeFetch, stripHtml } from "./base-adapter.js";

// NOTE: As of July 2026, cariforum.org is unreachable (connection timeout)
// from Replit's environment. This source is set active=false in the DB.
// The adapter is preserved for reactivation when a working URL is found.
export class EUCaribbeanAdapter implements TenderSourceAdapter {
  adapterType = "eu_caribbean";

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    const results: TenderOpportunity[] = [];
    const warnings: string[] = [];
    let requestsAttempted = 0;
    let requestsSucceeded = 0;

    const urls = [
      "https://www.cariforum.org/procurement",
      "https://www.cariforum.org/tenders",
      "https://www.cariforum.org/",
      "https://eulacfoundation.org/en/calls",
      "https://eulacfoundation.org/en/grants",
    ];

    const relevantTerms = [
      "communic", "visib", "awareness", "outreach", "campaign",
      "brand", "media", "engagement", "consult", "tender", "rfp",
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
          warnings.push(`EU Caribbean HTTP ${r.status} for ${url}`);
          continue;
        }
        const html = await r.text();
        if (html.length < 500) {
          warnings.push(`EU Caribbean very short response for ${url}`);
          continue;
        }
        requestsSucceeded++;

        const linkPattern = /<a[^>]+href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
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

    // Throw so the crawler records a failed source run rather than a silent zero-result success.
    if (requestsAttempted > 0 && requestsSucceeded === 0) {
      throw new Error(
        `EU Caribbean: all ${requestsAttempted} request(s) failed. ` +
        `cariforum.org is unreachable from this environment (connection timeout). ` +
        warnings.join("; "),
      );
    }

    return results;
  }
}
