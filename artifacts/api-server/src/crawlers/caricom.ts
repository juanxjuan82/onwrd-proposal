import {
  TenderSourceAdapter,
  TenderOpportunity,
  AdapterFetchContext,
  enrichWithRenderedDetail,
  extractDeadline,
  fetchHtmlWithOptionalBrowser,
  fetchTenderDetailWithOptionalBrowser,
  stripHtml,
} from "./base-adapter.js";

// CARICOM Secretariat — monitors regional communications, public awareness,
// stakeholder engagement and policy communications across the Caribbean Community.
export class CARICOMAdapter implements TenderSourceAdapter {
  adapterType = "caricom";

  async fetchOpportunities(context?: AdapterFetchContext): Promise<TenderOpportunity[]> {
    const results: TenderOpportunity[] = [];
    let requestsAttempted = 0;
    let requestsSucceeded = 0;
    const warnings: string[] = [];
    const seen = new Set<string>();

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
        const resultCountBeforePage = results.length;
        const page = await fetchHtmlWithOptionalBrowser(url, context, 500);
        const html = page.html;
        requestsSucceeded++;

        const linkPattern =
          /<a[^>]+href="([^"]*(?:procur|tender|rfp|bid|consult|communic|campaign|awareness|engagement)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
        let match;
        while ((match = linkPattern.exec(html)) !== null) {
           const href = match[1];
           const rawTitle = stripHtml(match[2], 200).trim();
          if (!rawTitle || rawTitle.length < 8) continue;
           const key = rawTitle.toLowerCase().slice(0, 100);
           if (seen.has(key)) continue;
           seen.add(key);

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
           const detail = await fetchTenderDetailWithOptionalBrowser(fullUrl, rawTitle, context);
           if (detail) description = detail.content;

          results.push({
            externalId: `caricom-${Buffer.from(rawTitle.slice(0, 40)).toString("base64").slice(0, 16)}`,
            title: rawTitle,
            organization: "CARICOM Secretariat",
            url: fullUrl,
             deadline: extractDeadline([description, detail?.metadata.deadline ?? ""].join(" ")),
            description,
            country: "Caribbean",
            sector: "Government & Public Communications",
             rawData: {
               sourcePage: url,
               adapterContext: "CARICOM Secretariat regional procurement and public communications.",
               extractionMethod: detail ? `${detail.method}_detail` : page.method,
               ...(detail ? { renderedMetadata: detail.metadata } : {}),
             },
          });

          if (results.length >= 15) break;
        }

         const renderedListing = page.rendered ??
           (results.length === resultCountBeforePage
             ? await enrichWithRenderedDetail(url, context)
             : undefined);
         if (renderedListing && results.length < 15) {
           for (const link of renderedListing.links) {
             const rawTitle = stripHtml(link.text, 200).trim();
             if (!isRelevantCaricomTitle(rawTitle)) continue;
             const key = rawTitle.toLowerCase().slice(0, 100);
             if (seen.has(key)) continue;
             seen.add(key);
             const detail = await fetchTenderDetailWithOptionalBrowser(link.url, rawTitle, context);
             // Never turn generic rendered listing text into tender scope.
             if (!detail) continue;
             const description = detail.content;
             results.push({
               externalId: `caricom-${Buffer.from(rawTitle.slice(0, 40)).toString("base64").slice(0, 16)}`,
               title: rawTitle,
               organization: "CARICOM Secretariat",
               url: link.url,
               deadline: extractDeadline([description, detail?.metadata.deadline ?? ""].join(" ")),
               description,
               country: "Caribbean",
               sector: "Government & Public Communications",
               rawData: {
                 sourcePage: url,
                 adapterContext: "CARICOM Secretariat regional procurement and public communications.",
                 extractionMethod: `${detail.method}_detail`,
                 renderedMetadata: detail.metadata,
               },
             });
             if (results.length >= 15) break;
           }
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

function isRelevantCaricomTitle(title: string): boolean {
  return title.length >= 8 && /procur|tender|rfp|bid|consult|communic|campaign|awareness|engagement/i.test(title);
}
