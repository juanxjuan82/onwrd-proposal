import { TenderSourceAdapter, TenderOpportunity, safeFetch, stripHtml } from "./base-adapter.js";

// CARICOM Secretariat — monitors regional communications, public awareness,
// stakeholder engagement and policy communications across the Caribbean Community.
export class CARICOMAdapter implements TenderSourceAdapter {
  adapterType = "caricom";

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    const results: TenderOpportunity[] = [];
    let requestsAttempted = 0;
    let requestsSucceeded = 0;
    const warnings: string[] = [];

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
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; TenderBot/1.0)",
            Accept: "text/html",
          },
        });
        if (!r.ok) {
          warnings.push(`CARICOM HTTP ${r.status} for ${url}`);
          continue;
        }
        const html = await r.text();
        if (html.length < 500) {
          warnings.push(`CARICOM very short response for ${url}`);
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

          // Extract surrounding page context around this link for a real description.
          // The ~600 chars around the href in the HTML typically includes the
          // containing paragraph or article block — deadline, scope summary, reference
          // number, organization unit, etc. Stripping HTML gives genuine content that
          // passes the eligibility content-quality gate without template padding.
          let description = `CARICOM Secretariat procurement notice: ${rawTitle}`;
          const hrefPos = html.indexOf(href, Math.max(0, (match.index ?? 0) - 20));
          if (hrefPos > 0) {
            const windowStart = Math.max(0, hrefPos - 300);
            const windowEnd = Math.min(html.length, hrefPos + 500);
            const contextText = stripHtml(html.slice(windowStart, windowEnd), 600)
              .replace(/\s+/g, " ")
              .trim();
            if (contextText.length > rawTitle.length + 80) {
              description = contextText.slice(0, 500);
            }
          }

          results.push({
            externalId: `caricom-${Buffer.from(rawTitle.slice(0, 40)).toString("base64").slice(0, 16)}`,
            title: rawTitle,
            organization: "CARICOM Secretariat",
            url: fullUrl,
            description,
            country: "Caribbean",
            sector: "Government & Public Communications",
          });

          if (results.length >= 15) break;
        }

        if (results.length > 0) break;
      } catch (err) {
        warnings.push(`CARICOM fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (requestsAttempted > 0 && requestsSucceeded === 0) {
      throw new Error(
        `CARICOM: all ${requestsAttempted} request(s) failed. ` +
        warnings.join("; "),
      );
    }

    return results;
  }
}
