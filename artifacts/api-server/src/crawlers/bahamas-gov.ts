import { stableExternalId } from "./dedup.js";
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

const TENDER_URLS = [
  "https://www.bahamas.gov.bs/tender-notices",
  "https://www.bahamas.gov.bs/tender-and-rfps",
];

// Map category text to a sector label
function mapCategory(cat: string): string {
  const c = cat.toLowerCase();
  if (c.includes("idb") || c.includes("inter-american")) return "IDB / Government";
  if (c.includes("caribbean development bank") || c.includes("cdb")) return "CDB / Government";
  if (c.includes("un ") || c.includes("united nations")) return "UN / Government";
  if (c.includes("tourism")) return "Tourism / Government";
  if (c.includes("finance") || c.includes("ministry of finance")) return "Finance / Government";
  if (c.includes("rfp") || c.includes("request for proposal")) return "Government Procurement";
  if (c.includes("expression of interest") || c.includes("eoi")) return "Government Procurement";
  if (c.includes("bid")) return "Government Procurement";
  return "Government";
}

export class BahamasGovAdapter implements TenderSourceAdapter {
  adapterType = "bahamas_gov";

  async fetchOpportunities(context?: AdapterFetchContext): Promise<TenderOpportunity[]> {
    const results: TenderOpportunity[] = [];
    const seen = new Set<string>();
    let requestsAttempted = 0;
    let requestsSucceeded = 0;
    const warnings: string[] = [];

    for (const pageUrl of TENDER_URLS) {
      requestsAttempted++;
      try {
        const resultCountBeforePage = results.length;
        const page = await fetchHtmlWithOptionalBrowser(pageUrl, context, 1000);
        const html = page.html;
        requestsSucceeded++;

        // Pattern 1: links with title + category span (tender-notices page format)
        const pattern1 = /<a\s+href="([^"]+)"[^>]*title="([^"]+)"[^>]*>[\s\S]*?<span class="category">([^<]+)<\/span>/g;
        let m: RegExpExecArray | null;
        while ((m = pattern1.exec(html)) !== null) {
          const url = m[1].trim();
          const title = stripHtml(m[2], 300);
          const category = m[3].trim();

          if (!title || title.length < 8) continue;
          if (url.includes("bahamas.gov.bs") && !url.includes("cdn.") && !url.includes("gov.bs/wps")) {
            // internal page link — not a document, skip
          }
          // Skip contract awards, job ads, and purely technical roles
          if (/notification of contract award|contract award/i.test(category)) continue;
          if (/junior|senior network|data engineer|systems administrator|software developer|business analyst|job seeker|network engineer|cirt (systems|deputy|security)|computer incident response/i.test(title)) continue;

          const key = title.toLowerCase().slice(0, 60);
          if (seen.has(key)) continue;
          seen.add(key);

           const fullUrl = url.startsWith("http") ? url : `https://www.bahamas.gov.bs${url}`;
           const detail = await fetchTenderDetailWithOptionalBrowser(fullUrl, title, context);
           const detailContent = detail?.content;
           const description = detailContent ?? extractListingContext(html, m.index, title, category);

          results.push({
             externalId: stableExternalId("bah", fullUrl, title),
            title,
            organization: "Government of The Bahamas",
             url: fullUrl,
             deadline: extractDeadline([description, detail?.metadata.deadline ?? ""].join(" ")),
             description,
            country: "Bahamas",
            sector: mapCategory(category),
             rawData: {
               sourcePage: pageUrl,
               extractionMethod: detail ? `${detail.method}_detail` : page.method,
               ...(detail ? {} : { needsEnrichment: true }),
               ...(detail ? { renderedMetadata: detail.metadata } : {}),
             },
          });
        }

        // Pattern 2: plain anchor links to CDN docs with recognisable tender titles
        const pattern2 = /href="(https:\/\/cdn\.bahamas\.gov\.bs\/[^"]+\.pdf)"[^>]*title="([^"]+)"/g;
        while ((m = pattern2.exec(html)) !== null) {
          const url = m[1].trim();
          const title = stripHtml(m[2], 300);
          if (!title || title.length < 8) continue;
          if (/notification of contract award|contract award/i.test(title)) continue;

          const key = title.toLowerCase().slice(0, 60);
          if (seen.has(key)) continue;
          seen.add(key);

           const detail = await fetchTenderDetailWithOptionalBrowser(url, title, context);
           const detailContent = detail?.content;
           const description = detailContent ?? extractListingContext(html, m.index, title, "Government Procurement");
           results.push({
            externalId: stableExternalId("bah", url),
            title,
            organization: "Government of The Bahamas",
            url,
             deadline: extractDeadline([description, detail?.metadata.deadline ?? ""].join(" ")),
             description,
            country: "Bahamas",
            sector: "Government Procurement",
             rawData: {
               sourcePage: pageUrl,
               extractionMethod: detail ? `${detail.method}_detail` : page.method,
             ...(detail ? {} : { needsEnrichment: true }),
               ...(detail ? { renderedMetadata: detail.metadata } : {}),
             },
          });
        }

        // A rendered page can expose links after JavaScript executes even when
        // the listing HTML has no matching anchor markup.
        const renderedListing = page.rendered ??
          (results.length === resultCountBeforePage
            ? await enrichWithRenderedDetail(pageUrl, context)
            : undefined);
        if (renderedListing) {
          for (const link of renderedListing.links) {
            const title = stripHtml(link.text, 300);
            if (!isRelevantBahamasTitle(title) || seen.has(title.toLowerCase().slice(0, 60))) continue;
            seen.add(title.toLowerCase().slice(0, 60));
            const detail = await fetchTenderDetailWithOptionalBrowser(link.url, title, context);
            // Retain the discovered listing even when detail enrichment fails.
            // The explicit flag lets downstream consumers retry enrichment.
            const description = detail?.content ??
              `Bahamas government procurement notice: ${title}`;
            results.push({
              externalId: stableExternalId("bah", link.url, title),
              title,
              organization: "Government of The Bahamas",
              url: link.url,
              deadline: extractDeadline([description, detail?.metadata.deadline ?? ""].join(" ")),
              description,
              country: "Bahamas",
              sector: mapCategory(title),
              rawData: {
                sourcePage: pageUrl,
                extractionMethod: detail ? `${detail.method}_detail` : "rendered_listing",
                ...(detail ? { renderedMetadata: detail.metadata } : { needsEnrichment: true }),
              },
            });
            if (results.length >= 30) break;
          }
        }

        if (results.length >= 30) break;
      } catch (err) {
        warnings.push(`Bahamas Gov fetch failed for ${pageUrl}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (requestsAttempted > 0 && requestsSucceeded === 0) {
      throw new Error(
        `Bahamas Gov: all ${requestsAttempted} request(s) failed. ` +
        warnings.join("; "),
      );
    }

    return results.slice(0, 30);
  }
}

function extractListingContext(html: string, matchIndex: number, title: string, category: string): string {
  const context = stripHtml(html.slice(Math.max(0, matchIndex - 300), matchIndex + 700), 1_200)
    .replace(/\s+/g, " ")
    .trim();
  if (context.length > title.length + 60) return context;
  return `${title}. Category: ${category}.`;
}

function isRelevantBahamasTitle(title: string): boolean {
  return title.length >= 8 &&
    !/notification of contract award|contract award|junior|senior network|data engineer|systems administrator|software developer|business analyst|job seeker|network engineer|cirt (systems|deputy|security)|computer incident response/i.test(title);
}
