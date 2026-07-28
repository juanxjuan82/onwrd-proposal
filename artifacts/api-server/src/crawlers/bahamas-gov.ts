import { TenderSourceAdapter, TenderOpportunity, safeFetch, stripHtml } from "./base-adapter.js";

const TENDER_URLS = [
  "https://www.bahamas.gov.bs/tender-notices",
  "https://www.bahamas.gov.bs/tender-and-rfps",
];

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

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

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    const results: TenderOpportunity[] = [];
    const seen = new Set<string>();
    let requestsAttempted = 0;
    let requestsSucceeded = 0;
    const warnings: string[] = [];

    for (const pageUrl of TENDER_URLS) {
      requestsAttempted++;
      try {
        const r = await safeFetch(pageUrl, {
          headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
        });
        if (!r.ok) {
          warnings.push(`Bahamas Gov HTTP ${r.status} for ${pageUrl}`);
          continue;
        }
        const html = await r.text();
        if (html.length < 1000) {
          warnings.push(`Bahamas Gov very short response for ${pageUrl}`);
          continue;
        }
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

          const externalId = `bah-${Buffer.from((url + title).slice(0, 50)).toString("base64").slice(0, 16)}`;

          results.push({
            externalId,
            title,
            organization: "Government of The Bahamas",
            url: url.startsWith("http") ? url : `https://www.bahamas.gov.bs${url}`,
            description: `Bahamas government procurement notice. Category: ${category}. Source: ${pageUrl}`,
            country: "Bahamas",
            sector: mapCategory(category),
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

          results.push({
            externalId: `bah-${Buffer.from(url.slice(-40)).toString("base64").slice(0, 16)}`,
            title,
            organization: "Government of The Bahamas",
            url,
            description: `Bahamas government tender document: ${title}`,
            country: "Bahamas",
            sector: "Government Procurement",
          });
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
