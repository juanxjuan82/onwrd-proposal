import { stableExternalId } from "./dedup.js";
import {
  TenderSourceAdapter,
  TenderOpportunity,
  AdapterFetchContext,
  enrichWithRenderedDetail,
  extractDeadline,
  extractProcurementDocuments,
  fetchHtmlWithOptionalBrowser,
  fetchTenderDetailWithOptionalBrowser,
  stripHtml,
} from "./base-adapter.js";

const TENDER_URLS = [
  "https://www.bahamas.gov.bs/tender-notices",
  "https://www.bahamas.gov.bs/tender-and-rfps",
];
const BAHAMAS_DOMAINS = ["bahamas.gov.bs"];
const MAX_NOTICES_PER_RUN = 30;
// The government site never removes old notices (most rows on the page are
// from 2022-2024). A notice with no due date is only kept while its document
// was uploaded recently.
const MAX_UNDATED_NOTICE_AGE_DAYS = 180;

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

export interface BahamasListing {
  url: string;
  title: string;
  category: string;
  dueDate?: Date;
  /** Upload time taken from the document file name (…-YYYYMMDDhhmmss.pdf). */
  uploadedAt?: Date;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
}

function uploadDateFromUrl(url: string): Date | undefined {
  const stamp = url.match(/-(20\d{2})(\d{2})(\d{2})\d{6}\.[a-z0-9]+(?:[?#]|$)/i);
  if (!stamp) return undefined;
  const date = new Date(Date.UTC(Number(stamp[1]), Number(stamp[2]) - 1, Number(stamp[3])));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Read the tender rows of a bahamas.gov.bs listing page. Each notice is one
 * <li> holding a category, an optional "Due Date", and a titled link. Reading
 * row by row keeps site navigation links from being mistaken for tenders.
 */
export function parseBahamasTenderList(html: string): BahamasListing[] {
  const listings: BahamasListing[] = [];
  for (const rowMatch of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const row = rowMatch[1];
    const category = row.match(/<span[^>]*class="[^"]*\bcategory\b[^"]*"[^>]*>([^<]*)<\/span>/i)?.[1];
    if (category === undefined) continue;
    const anchor = row.match(/<h2\b[^>]*>\s*<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      ?? row.match(/<a\b[^>]*href="([^"]+)"[^>]*title="([^"]+)"/i);
    if (!anchor) continue;
    const title = decodeEntities(stripHtml(anchor[2], 300)).trim();
    const href = decodeEntities(anchor[1].trim());
    let url: string;
    try {
      url = new URL(href, "https://www.bahamas.gov.bs").toString();
    } catch {
      continue;
    }
    const dueText = row.match(/<span[^>]*class="[^"]*\bdue-date\b[^"]*"[^>]*>([^<]*)<\/span>/i)?.[1] ?? "";
    listings.push({
      url,
      title,
      category: decodeEntities(category).trim(),
      dueDate: dueText ? extractDeadline(dueText) : undefined,
      uploadedAt: uploadDateFromUrl(url),
    });
  }
  return listings;
}

/** Why a listing row is not a live tender, or null when it should be kept. */
export function bahamasListingRejection(listing: BahamasListing, now = new Date()): string | null {
  if (listing.title.length < 8) return "no_title";
  let parsed: URL;
  try {
    parsed = new URL(listing.url);
  } catch {
    return "bad_url";
  }
  const host = parsed.hostname.toLowerCase();
  // Rows that only point at another organisation's portal (UN, IDB, BEST)
  // are signposts, not tenders we can read.
  if (!BAHAMAS_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))) return "external_link";
  if (parsed.pathname === "/" || parsed.pathname === "") return "navigation_link";
  if (/contract\s*award/i.test(`${listing.title} ${listing.category} ${decodeURIComponent(parsed.pathname)}`)) {
    return "contract_award";
  }
  if (!isRelevantBahamasTitle(listing.title)) return "job_posting";
  if (listing.dueDate) {
    // The due date is a calendar day; keep the notice until that day is over.
    return listing.dueDate.getTime() + 24 * 60 * 60 * 1000 < now.getTime() ? "expired" : null;
  }
  if (listing.uploadedAt) {
    const ageDays = (now.getTime() - listing.uploadedAt.getTime()) / (24 * 60 * 60 * 1000);
    if (ageDays > MAX_UNDATED_NOTICE_AGE_DAYS) return "stale_undated";
  }
  return null;
}

export class BahamasGovAdapter implements TenderSourceAdapter {
  adapterType = "bahamas_gov";

  async fetchOpportunities(context?: AdapterFetchContext): Promise<TenderOpportunity[]> {
    const results: TenderOpportunity[] = [];
    const seen = new Set<string>();
    let requestsAttempted = 0;
    let requestsSucceeded = 0;
    const warnings: string[] = [];
    const skipped: Record<string, number> = {};
    const now = new Date();

    for (const pageUrl of TENDER_URLS) {
      requestsAttempted++;
      try {
        const page = await fetchHtmlWithOptionalBrowser(pageUrl, context, 1000);
        requestsSucceeded++;

        let listings = parseBahamasTenderList(page.html);
        let listingMethod: string = page.method;
        if (listings.length === 0) {
          // A rendered page can expose links after JavaScript executes even
          // when the listing HTML has no tender rows.
          const rendered = page.rendered ?? await enrichWithRenderedDetail(pageUrl, context);
          if (rendered) {
            listingMethod = "rendered_listing";
            listings = rendered.links.map((link) => ({
              url: link.url,
              title: stripHtml(link.text, 300),
              category: "Government Procurement",
              uploadedAt: uploadDateFromUrl(link.url),
            }));
          }
        }

        for (const listing of listings) {
          if (results.length >= MAX_NOTICES_PER_RUN) break;
          const rejection = bahamasListingRejection(listing, now);
          if (rejection) {
            skipped[rejection] = (skipped[rejection] ?? 0) + 1;
            continue;
          }
          const key = listing.title.toLowerCase().slice(0, 60);
          if (seen.has(key)) continue;
          seen.add(key);

          const scope = await this.readScope(listing, context);
          const dueLabel = listing.dueDate
            ? ` Due date: ${listing.dueDate.toISOString().slice(0, 10)}.`
            : "";
          const description = scope?.content ??
            `${listing.title}. Category: ${listing.category}.${dueLabel}`;

          results.push({
            externalId: stableExternalId("bah", listing.url, listing.title),
            title: listing.title,
            organization: "Government of The Bahamas",
            url: listing.url,
            deadline: listing.dueDate ?? extractDeadline(description),
            description,
            country: "Bahamas",
            sector: mapCategory(listing.category),
            rawData: {
              sourcePage: pageUrl,
              category: listing.category,
              extractionMethod: scope ? scope.method : listingMethod,
              ...(listing.uploadedAt ? { documentUploadedAt: listing.uploadedAt.toISOString() } : {}),
              ...(scope ? {} : { needsEnrichment: true }),
              ...(scope?.rawData ?? {}),
            },
          });
        }

        if (results.length >= MAX_NOTICES_PER_RUN) break;
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

    const skippedSummary = Object.entries(skipped).map(([reason, count]) => `${reason}=${count}`).join(", ");
    if (skippedSummary) {
      console.log(`[BahamasGovAdapter] kept ${results.length}; skipped ${skippedSummary}`);
      context?.diagnostics?.push({
        code: "direct_success",
        url: TENDER_URLS[0],
        message: `Kept ${results.length} live notices; skipped ${skippedSummary}.`,
        method: "direct",
      });
    }

    return results.slice(0, MAX_NOTICES_PER_RUN);
  }

  /** Read the real scope of a notice: PDF/Word text for documents, page text otherwise. */
  private async readScope(
    listing: BahamasListing,
    context: AdapterFetchContext | undefined,
  ): Promise<{ content: string; method: string; rawData: Record<string, unknown> } | undefined> {
    const domains = context?.approvedDomains ?? BAHAMAS_DOMAINS;
    if (/\.(?:pdf|docx)(?:[?#]|$)/i.test(listing.url)) {
      const escaped = listing.url.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
      const documents = await extractProcurementDocuments(
        `<a href="${escaped}">tender notice document</a>`,
        listing.url,
        domains,
        undefined,
        undefined,
        context?.robotsAllows,
      );
      const document = documents.find((item) => item.status === "extracted" && item.text);
      const documentExtraction = documents.map(({ url, format, status, characters, text }) => ({
        url, format, status, characters,
        ...(text ? { extractedText: text.slice(0, 4_000) } : {}),
      }));
      if (!document?.text) return undefined;
      const text = document.text.replace(/\s+/g, " ").trim();
      if (text.length < 120) return undefined;
      return {
        content: `${listing.title}. ${text}`.slice(0, 4_000),
        method: "direct_document",
        rawData: { documentExtraction, documentUrls: [listing.url] },
      };
    }
    const detail = await fetchTenderDetailWithOptionalBrowser(listing.url, listing.title, context);
    if (!detail) return undefined;
    return {
      content: detail.content,
      method: `${detail.method}_detail`,
      rawData: { renderedMetadata: detail.metadata },
    };
  }
}

function isRelevantBahamasTitle(title: string): boolean {
  return title.length >= 8 &&
    !/notification of contract award|contract award|junior|senior network|data engineer|systems administrator|software developer|business analyst|job seeker|network engineer|cirt (systems|deputy|security)|computer incident response/i.test(title);
}
