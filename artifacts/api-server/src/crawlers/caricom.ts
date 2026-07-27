import { TenderSourceAdapter, TenderOpportunity, AdapterFetchResult, safeFetch, stripHtml } from "./base-adapter.js";

// CARICOM Secretariat — regional communications, public awareness,
// stakeholder engagement and policy communications across the Caribbean Community.
export class CARICOMAdapter implements TenderSourceAdapter {
  adapterType = "caricom";

  async fetchOpportunities(): Promise<AdapterFetchResult> {
    const warnings: string[] = [];
    let requestsAttempted = 0;
    let requestsSucceeded = 0;
    const results: TenderOpportunity[] = [];

    const urls = [
      "https://caricom.org/procurement-notices",
      "https://caricom.org/procurement",
      "https://caricom.org/tenders",
      "https://caricom.org/news-and-media",
      "https://caricom.org/",
    ];

    for (const url of urls) {
      requestsAttempted++;
      try {
        const r = await safeFetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; TenderBot/1.0)", Accept: "text/html" },
        });
        if (!r.ok) {
          warnings.push(`CARICOM HTTP ${r.status} for ${url}`);
          continue;
        }
        const html = await r.text();
        if (html.length < 500) {
          warnings.push(`CARICOM returned very short response for ${url}`);
          continue;
        }
        requestsSucceeded++;

        const linkPattern =
          /<a[^>]+href="([^"]*(?:procur|tender|rfp|bid|consult|communic|campaign|awareness|engagement)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
        let match;
        const seen = new Set<string>();

        while ((match = linkPattern.exec(html)) !== null) {
          const href = match[1];
          const rawTitle = stripHtml(match[2], 200).trim();
          if (!rawTitle || rawTitle.length < 8) continue;
          if (seen.has(rawTitle)) continue;
          seen.add(rawTitle);

          const fullUrl = href.startsWith("http") ? href : `https://caricom.org${href}`;

          results.push({
            externalId: `caricom-${Buffer.from((rawTitle + href).slice(0, 40)).toString("base64").slice(0, 16)}`,
            title: rawTitle,
            organization: "CARICOM Secretariat",
            url: fullUrl,
            description: `CARICOM procurement notice: ${rawTitle}`,
            country: "Caribbean",
            sector: "Regional Development",
          });

          if (results.length >= 20) break;
        }

        if (results.length > 0) break;
      } catch (err) {
        warnings.push(`CARICOM fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (requestsAttempted > 0 && requestsSucceeded === 0) {
      throw new Error(`CARICOM: all ${requestsAttempted} requests failed. ` + warnings.join("; "));
    }

    return { opportunities: results, requestsAttempted, requestsSucceeded, warnings };
  }
}
