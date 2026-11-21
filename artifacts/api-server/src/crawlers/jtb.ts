import { stableExternalId } from "./dedup.js";
import {
  AdapterFetchContext,
  TenderOpportunity,
  TenderSourceAdapter,
  extractProcurementDocuments,
  fetchApprovedBytes,
  fetchApprovedText,
  robotsPathAllowed,
} from "./base-adapter.js";
import { decodeEntities, listingRejection, readListingDeadline } from "./listing-adapter.js";

// Jamaica Tourist Board (JTB) adapter.
//
// The JTB does not keep a tender list: its procurement page table is empty and
// each tender is published as a PDF advert (e.g. "Ad Agency – EOI Ad 2025",
// "PR UK – EOI 2025", "RFP Ad Data Verification System"). Those PDFs are all
// in the site's public WordPress media library, which has a read-only JSON
// feed. We search that feed for tender wording, keep recent PDFs, and read the
// advert text for scope and deadline.
const JTB_ORIGIN = "https://www.jtbonline.org";
const JTB_MEDIA_API = `${JTB_ORIGIN}/wp-json/wp/v2/media`;
const JTB_DOMAINS = ["jtbonline.org"];
// The media library stores its files in this bucket, under this folder only.
const JTB_FILE_HOST = "lcms-mysql-server.s3.us-east-2.amazonaws.com";
const JTB_FILE_PATH_PREFIX = "/jtbonline.org/wp-content/uploads/";
const SEARCH_TERMS = ["RFP", "EOI", "Expression of Interest", "Request for", "Tender", "Procurement", "Quotation"];
const TENDER_TITLE = /\b(?:rfp|rfq|eoi|expressions? of interest|request for|tender|procurement|quotation|invitation to bid|bid)\b/i;
const NOT_A_TENDER = /\b(?:withdraw\w*|award\w*|cancell?\w*|results?)\b/i;
const LOOKBACK_DAYS = 150;
const MAX_UNDATED_AGE_DAYS = 120;
const MAX_NOTICES_PER_RUN = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

interface JtbMediaItem {
  id?: number;
  date?: string;
  link?: string;
  mime_type?: string;
  source_url?: string;
  title?: { rendered?: string };
}

export interface JtbAdvert {
  id: number;
  title: string;
  fileUrl: string;
  postedAt?: Date;
}

/** Keep only recent tender PDFs stored in the JTB's own file folder. */
export function selectJtbAdverts(items: readonly JtbMediaItem[]): JtbAdvert[] {
  const adverts: JtbAdvert[] = [];
  const seen = new Set<number>();
  for (const item of items) {
    if (typeof item.id !== "number" || seen.has(item.id)) continue;
    if (item.mime_type !== "application/pdf" || !item.source_url) continue;
    let file: URL;
    try {
      file = new URL(item.source_url);
    } catch {
      continue;
    }
    const host = file.hostname.toLowerCase();
    const onJtbSite = host === "jtbonline.org" || host.endsWith(".jtbonline.org");
    const inJtbFolder = host === JTB_FILE_HOST && file.pathname.startsWith(JTB_FILE_PATH_PREFIX);
    if (file.protocol !== "https:" || (!onJtbSite && !inJtbFolder)) continue;
    const title = decodeEntities(item.title?.rendered ?? "")
      .replace(/<[^>]+>/g, " ").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
    if (!TENDER_TITLE.test(title) || NOT_A_TENDER.test(title)) continue;
    seen.add(item.id);
    const postedAt = item.date ? new Date(`${item.date}Z`) : undefined;
    adverts.push({
      id: item.id,
      title,
      fileUrl: file.toString(),
      postedAt: postedAt && !Number.isNaN(postedAt.getTime()) ? postedAt : undefined,
    });
  }
  return adverts.sort((a, b) => (b.postedAt?.getTime() ?? 0) - (a.postedAt?.getTime() ?? 0));
}

export class JTBAdapter implements TenderSourceAdapter {
  adapterType = "jtb";
  private lastRequestCompletedAt = 0;

  constructor(private readonly requestIntervalMs = 1_000) {}

  async fetchOpportunities(context?: AdapterFetchContext): Promise<TenderOpportunity[]> {
    const robots = await this.fetchText(`${JTB_ORIGIN}/robots.txt`, 256_000, { headers: { Accept: "text/plain" } });
    if (!robots.response.ok || !/^text\/plain\b/i.test(robots.response.headers.get("content-type") ?? "")) {
      throw new Error(`JTB robots.txt could not be verified (HTTP ${robots.response.status}); refusing to crawl.`);
    }
    if (!robotsPathAllowed(robots.text, new URL(JTB_MEDIA_API).pathname)) {
      throw new Error("JTB robots.txt disallows the media feed path.");
    }

    const now = new Date();
    const after = new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS).toISOString().slice(0, 19);
    const items: JtbMediaItem[] = [];
    const failures: string[] = [];
    let searchesSucceeded = 0;
    for (const term of SEARCH_TERMS) {
      const url = `${JTB_MEDIA_API}?search=${encodeURIComponent(term)}&mime_type=application/pdf` +
        `&after=${encodeURIComponent(after)}&per_page=20&orderby=date&order=desc` +
        `&_fields=id,date,link,title,mime_type,source_url`;
      try {
        const page = await this.fetchText(url, 1_000_000, { headers: { Accept: "application/json" } });
        if (!page.response.ok) {
          failures.push(`"${term}": HTTP ${page.response.status}`);
          continue;
        }
        const parsed: unknown = JSON.parse(page.text);
        if (Array.isArray(parsed)) items.push(...(parsed as JtbMediaItem[]));
        searchesSucceeded++;
      } catch (error) {
        failures.push(`"${term}": ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (searchesSucceeded === 0) {
      throw new Error(`JTB media feed: all ${SEARCH_TERMS.length} searches failed. ${failures.join("; ")}`);
    }

    const results: TenderOpportunity[] = [];
    const skipped: Record<string, number> = {};
    for (const advert of selectJtbAdverts(items)) {
      if (results.length >= MAX_NOTICES_PER_RUN) break;
      const escaped = advert.fileUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
      const documents = await extractProcurementDocuments(
        `<a href="${escaped}">tender notice document</a>`,
        advert.fileUrl,
        [...JTB_DOMAINS, JTB_FILE_HOST],
        (url, domains, maxBytes) => this.fetchBytes(url, domains, maxBytes),
      );
      const document = documents[0];
      const text = (document?.text ?? "").replace(/\s+/g, " ").trim();
      const deadline = readListingDeadline(text);
      const rejection = listingRejection(
        { deadline, postedAt: advert.postedAt },
        { maxUndatedAgeDays: MAX_UNDATED_AGE_DAYS },
        now,
      );
      if (rejection) {
        skipped[rejection] = (skipped[rejection] ?? 0) + 1;
        continue;
      }
      const hasText = text.length >= 120;
      results.push({
        externalId: stableExternalId("jtb", advert.fileUrl),
        title: advert.title,
        organization: "Jamaica Tourist Board",
        url: advert.fileUrl,
        deadline,
        description: hasText ? `${advert.title}. ${text}`.slice(0, 4_000) : "",
        country: "Jamaica",
        sector: "Tourism / Government",
        rawData: {
          sourcePage: `${JTB_ORIGIN}/public-offerings/procurement/`,
          mediaId: advert.id,
          extractionMethod: hasText ? "direct_document" : "media_feed",
          descriptionStatus: hasText ? "substantive" : "insufficient_scope",
          documentStatus: document?.status ?? "none_found",
          documentUrls: [advert.fileUrl],
          ...(advert.postedAt ? { postedAt: advert.postedAt.toISOString() } : {}),
          ...(hasText ? {} : { needsEnrichment: true }),
        },
      });
    }

    const skippedSummary = Object.entries(skipped).map(([reason, count]) => `${reason}=${count}`).join(", ");
    context?.diagnostics?.push({
      code: "direct_success",
      url: JTB_MEDIA_API,
      message: `Kept ${results.length} open adverts${skippedSummary ? `; skipped ${skippedSummary}` : ""}.`,
      method: "direct",
    });
    return results;
  }

  private async waitForNextRequest(): Promise<void> {
    if (this.lastRequestCompletedAt > 0 && this.requestIntervalMs > 0) {
      const remaining = this.requestIntervalMs - (Date.now() - this.lastRequestCompletedAt);
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  }

  private async fetchText(url: string, maxBytes: number, options: RequestInit) {
    await this.waitForNextRequest();
    try {
      return await fetchApprovedText(url, JTB_DOMAINS, maxBytes, options);
    } finally {
      this.lastRequestCompletedAt = Date.now();
    }
  }

  private async fetchBytes(
    url: string,
    domains: readonly string[],
    maxBytes: number,
  ): ReturnType<typeof fetchApprovedBytes> {
    await this.waitForNextRequest();
    try {
      return await fetchApprovedBytes(url, domains, maxBytes);
    } finally {
      this.lastRequestCompletedAt = Date.now();
    }
  }
}
