import { TenderSourceAdapter, TenderOpportunity, AdapterFetchResult, FetchFn, safeFetch, stripHtml, fetchDetailDescription, extractPdfText } from "./base-adapter.js";

// Bahamas Government Procurement adapter.
//
// NOTE: bahamas.gov.bs returns HTTP 403 as of July 2026 — the site blocks
// server-to-server requests. The adapter is kept active so that fixture-based
// tests exercise the real parsing path. Do NOT report this source as fixed;
// live data is unavailable from Replit without infrastructure changes.
//
// Two listing formats are handled:
//   Pattern 1 — <a href="..." title="..."><span class="category">...</span></a>
//   Pattern 2 — href="https://cdn.bahamas.gov.bs/...pdf" title="..."
//
// For Pattern 1 links, fetchDetailDescription() is called to get real scope.
// For Pattern 2 PDF links, the PDF is downloaded and extractPdfText() is used.
// In both cases, if substantive content (>=120 chars) is not found, description
// is set to the title so the eligibility gate can correctly reject it as
// title_only rather than silently promoting a padded placeholder.

const TENDER_URLS = [
  "https://www.bahamas.gov.bs/tender-notices",
  "https://www.bahamas.gov.bs/tender-and-rfps",
];

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

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

  constructor(private fetchFn: FetchFn = safeFetch) {}

  async fetchOpportunities(): Promise<AdapterFetchResult> {
    const warnings: string[] = [];
    let requestsAttempted = 0;
    let requestsSucceeded = 0;
    const results: TenderOpportunity[] = [];
    const seen = new Set<string>();

    for (const pageUrl of TENDER_URLS) {
      requestsAttempted++;
      try {
        const r = await this.fetchFn(pageUrl, {
          headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
        });
        if (!r.ok) {
          const hint = r.status === 403
            ? "site blocks server-to-server access from this environment"
            : `HTTP ${r.status}`;
          warnings.push(`Bahamas Gov ${hint} for ${pageUrl}`);
          continue;
        }
        const html = await r.text();
        if (html.length < 1000) {
          warnings.push(`Bahamas Gov returned very short response (${html.length} chars) for ${pageUrl}`);
          continue;
        }
        requestsSucceeded++;

        // ── Pattern 1: HTML detail links ──────────────────────────────────────
        const pattern1 = /<a\s+href="([^"]+)"[^>]*title="([^"]+)"[^>]*>[\s\S]*?<span class="category">([^<]+)<\/span>/g;
        let m: RegExpExecArray | null;
        while ((m = pattern1.exec(html)) !== null) {
          const href = m[1].trim();
          const title = stripHtml(m[2], 300);
          const category = m[3].trim();

          if (!title || title.length < 8) continue;
          if (/notification of contract award|contract award/i.test(category)) continue;
          if (/junior|senior network|data engineer|systems administrator|software developer|business analyst|job seeker|network engineer|cirt|computer incident response/i.test(title)) continue;

          const key = title.toLowerCase().slice(0, 60);
          if (seen.has(key)) continue;
          seen.add(key);

          const fullUrl = href.startsWith("http") ? href : `https://www.bahamas.gov.bs${href}`;
          const externalId = `bah-${Buffer.from((href + title).slice(0, 50)).toString("base64").slice(0, 16)}`;

          // Fetch detail page for real scope
          let description = "";
          const detail = await fetchDetailDescription(fullUrl, this.fetchFn);
          if (detail && detail.length >= 120) {
            description = detail;
          } else {
            // Fall back to title — eligibility gate marks as title_only
            description = title;
          }

          results.push({
            externalId,
            title,
            organization: "Government of The Bahamas",
            url: fullUrl,
            description,
            country: "Bahamas",
            sector: mapCategory(category),
          });
        }

        // ── Pattern 2: CDN PDF links ──────────────────────────────────────────
        const pattern2 = /href="(https:\/\/cdn\.bahamas\.gov\.bs\/[^"]+\.pdf)"[^>]*title="([^"]+)"/g;
        while ((m = pattern2.exec(html)) !== null) {
          const url = m[1].trim();
          const title = stripHtml(m[2], 300);
          if (!title || title.length < 8) continue;
          if (/notification of contract award|contract award/i.test(title)) continue;

          const key = title.toLowerCase().slice(0, 60);
          if (seen.has(key)) continue;
          seen.add(key);

          // Download and parse the PDF
          let description = "";
          try {
            const pdfResp = await this.fetchFn(url, { headers: { "User-Agent": USER_AGENT } });
            if (pdfResp.ok) {
              const buf = Buffer.from(await pdfResp.arrayBuffer());
              const extracted = await extractPdfText(buf, 2000);
              if (extracted.length >= 120) {
                description = extracted.slice(0, 1200);
              }
            }
          } catch {
            // PDF download failed — fall through to title-only
          }
          if (!description) {
            // No extractable content — use title so eligibility gate marks as title_only
            description = title;
          }

          results.push({
            externalId: `bah-${Buffer.from(url.slice(-40)).toString("base64").slice(0, 16)}`,
            title,
            organization: "Government of The Bahamas",
            url,
            description,
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
        `bahamas.gov.bs returns 403 — site blocks server-to-server access from this environment. ` +
        warnings.join("; "),
      );
    }

    return { opportunities: results.slice(0, 30), requestsAttempted, requestsSucceeded, warnings };
  }
}
