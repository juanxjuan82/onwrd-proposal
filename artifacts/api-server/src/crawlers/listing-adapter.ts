import { stableExternalId } from "./dedup.js";
import {
  AdapterFetchContext,
  TenderOpportunity,
  TenderSourceAdapter,
  extractDeadline,
  extractNoticeContent,
  extractProcurementDocuments,
  fetchApprovedBytes,
  fetchApprovedText,
  hasSubstantiveScope,
  prioritizeDocumentContent,
  resolveNoticeUrl,
  robotsPathAllowed,
  stripHtml,
} from "./base-adapter.js";

/**
 * One description of a "listing page" source: a public page that lists tender
 * notices as repeated blocks, each linking to a detail page on the same site.
 * Adding a source of this shape is a config entry, not a new adapter.
 */
export interface ListingSourceConfig {
  adapterType: string;
  label: string;
  organization: string;
  /** Country/region label used for geography scoring. */
  country: string;
  sector: string;
  origin: string;
  listingUrls: readonly string[];
  approvedDomains: readonly string[];
  /** Matches one notice block in the listing HTML (must be a global regex). */
  blockPattern: RegExp;
  /** Path a notice detail link must match (the listing page itself is ignored). */
  noticePath: RegExp;
  /** A block matching this is not an open tender (e.g. a "Closed" badge). */
  skipBlock?: RegExp;
  /** Where the notice text sits on a detail page with no <main>/<article>. */
  contentPattern?: RegExp;
  /** Reads a posting month from the notice URL, e.g. /files/2026-07/name.pdf. */
  postedFromUrl?: RegExp;
  /** Removed from the start of link text to leave the notice name. */
  titlePrefix?: RegExp;
  /** Undated notices older than this many days (by posted date) are dropped. */
  maxUndatedAgeDays?: number;
}

export interface ParsedListing {
  title: string;
  url: string;
  summary: string;
  deadline?: Date;
  postedAt?: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_NOTICES_PER_RUN = 15;

export function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&nbsp;/g, " ")
    .replace(/&(?:ndash|mdash);/g, "-").replace(/&(?:rsquo|lsquo|apos);/g, "'")
    .replace(/&(?:rdquo|ldquo);/g, "\"");
}

function blockText(html: string, maxLen: number): string {
  // Decode numeric entities before stripHtml blanks them out.
  return stripHtml(decodeEntities(html.replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")), maxLen)
    .replace(/\s+/g, " ").trim();
}

/**
 * Sites word their dates differently ("Closes 27 November 2026",
 * "Deadline: Monday, Nov 16, 2026"). Normalise to wording extractDeadline reads.
 */
export function readListingDeadline(text: string): Date | undefined {
  const normalised = text
    .replace(/\b(?:mon|tues|wednes|thurs|fri|satur|sun)day,?\s+/gi, "")
    .replace(/\b(?:closes|closing|close date|submission date)\b\s*:?\s*/gi, "Closing date: ")
    .replace(/(\d{1,2})(?:st|nd|rd|th)\b/gi, "$1")
    .replace(/\s*,\s*/g, ", ");
  return extractDeadline(normalised);
}

function readPostedDate(text: string): Date | undefined {
  const labelled = text.match(/\b(?:issued|posted|published)\b\s*:?\s*(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i)?.[1]
    ?? text.match(/^\s*(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})\b/)?.[1];
  return labelled ? extractDeadline(`Deadline: ${labelled}`) : undefined;
}

function readPostedFromUrl(url: string, config: ListingSourceConfig): Date | undefined {
  const match = config.postedFromUrl ? decodeURIComponent(url).match(config.postedFromUrl) : null;
  if (!match) return undefined;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Read the notice blocks of a listing page. Pure: no network access. */
export function parseListingPage(
  html: string,
  pageUrl: string,
  config: ListingSourceConfig,
): ParsedListing[] {
  const results: ParsedListing[] = [];
  const seen = new Set<string>();
  const pattern = new RegExp(config.blockPattern.source, config.blockPattern.flags.includes("g")
    ? config.blockPattern.flags
    : `${config.blockPattern.flags}g`);
  for (const blockMatch of html.matchAll(pattern)) {
    const block = blockMatch[0];
    if (config.skipBlock?.test(block)) continue;
    let chosen: { url: string; title: string } | undefined;
    for (const anchor of block.matchAll(/<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
      const url = resolveNoticeUrl(anchor[2], pageUrl, config.approvedDomains);
      if (!url) continue;
      const path = new URL(url).pathname;
      if (!config.noticePath.test(path)) continue;
      const title = blockText(anchor[3], 250).replace(config.titlePrefix ?? /^$/, "").trim();
      // "Read more" style links point at the notice but do not name it.
      if (title.length < 8 || /^(?:read more|learn more|view|details|download)$/i.test(title)) continue;
      chosen = { url, title };
      break;
    }
    if (!chosen) continue;
    const key = chosen.url.replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const summary = blockText(block, 1_500);
    results.push({
      ...chosen,
      summary,
      deadline: readListingDeadline(summary),
      postedAt: readPostedDate(summary) ?? readPostedFromUrl(chosen.url, config),
    });
  }
  return results;
}

/** Why a listed notice is not worth storing, or null when it should be kept. */
export function listingRejection(
  listing: Pick<ParsedListing, "deadline" | "postedAt">,
  config: Pick<ListingSourceConfig, "maxUndatedAgeDays">,
  now = new Date(),
): string | null {
  if (listing.deadline) {
    // The deadline is a calendar day; keep the notice until that day is over.
    return listing.deadline.getTime() + DAY_MS < now.getTime() ? "expired" : null;
  }
  if (listing.postedAt && config.maxUndatedAgeDays !== undefined &&
      (now.getTime() - listing.postedAt.getTime()) / DAY_MS > config.maxUndatedAgeDays) {
    return "stale_undated";
  }
  return null;
}

export class ListingAdapter implements TenderSourceAdapter {
  adapterType: string;
  private lastRequestCompletedAt = 0;

  constructor(
    private readonly config: ListingSourceConfig,
    private readonly requestIntervalMs = 1_000,
  ) {
    this.adapterType = config.adapterType;
  }

  async fetchOpportunities(context?: AdapterFetchContext): Promise<TenderOpportunity[]> {
    const { config } = this;
    const robotsAllows = await this.loadRobots();
    const now = new Date();
    const results: TenderOpportunity[] = [];
    const seen = new Set<string>();
    const skipped: Record<string, number> = {};
    let listingsRead = 0;
    const failures: string[] = [];

    for (const listingUrl of config.listingUrls) {
      if (results.length >= MAX_NOTICES_PER_RUN) break;
      if (!robotsAllows(listingUrl)) {
        failures.push(`${listingUrl}: disallowed by robots.txt`);
        continue;
      }
      let html: string;
      try {
        const listing = await this.fetchText(listingUrl, 2_000_000, { headers: { Accept: "text/html" } });
        if (!listing.response.ok) {
          failures.push(`${listingUrl}: HTTP ${listing.response.status}`);
          continue;
        }
        html = listing.text;
      } catch (error) {
        failures.push(`${listingUrl}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      listingsRead++;

      for (const listing of parseListingPage(html, listingUrl, config)) {
        if (results.length >= MAX_NOTICES_PER_RUN) break;
        if (seen.has(listing.url)) continue;
        seen.add(listing.url);
        const earlyRejection = listingRejection(listing, config, now);
        if (earlyRejection) {
          skipped[earlyRejection] = (skipped[earlyRejection] ?? 0) + 1;
          continue;
        }

        const detail = await this.readDetail(listing.url, robotsAllows);
        const deadline = listing.deadline ?? readListingDeadline(detail.content);
        const lateRejection = listingRejection({ deadline, postedAt: listing.postedAt }, config, now);
        if (lateRejection) {
          skipped[lateRejection] = (skipped[lateRejection] ?? 0) + 1;
          continue;
        }

        const combined = prioritizeDocumentContent(detail.content, detail.documents, 4_000);
        const detailHasScope = hasSubstantiveScope(combined, listing.title);
        const listingHasScope = hasSubstantiveScope(listing.summary, listing.title);
        const description = detailHasScope ? combined : listingHasScope ? listing.summary : "";
        results.push({
          externalId: stableExternalId(config.adapterType, listing.url),
          title: listing.title,
          organization: config.organization,
          url: listing.url,
          deadline,
          description,
          country: config.country,
          sector: config.sector,
          rawData: {
            sourcePage: listingUrl,
            noticeUrl: listing.url,
            listingContext: listing.summary,
            extractionMethod: detailHasScope ? "direct_detail" : "listing_context",
            detailFetchStatus: detail.status,
            descriptionStatus: description ? "substantive" : "insufficient_scope",
            documentExtraction: detail.documents,
            documentUrls: detail.documents.map((document) => document.url),
            ...(listing.postedAt ? { postedAt: listing.postedAt.toISOString() } : {}),
            ...(description ? {} : { needsEnrichment: true }),
          },
        });
      }
    }

    if (listingsRead === 0) {
      throw new Error(`${config.label}: no listing page could be read. ${failures.join("; ")}`);
    }
    const skippedSummary = Object.entries(skipped).map(([reason, count]) => `${reason}=${count}`).join(", ");
    context?.diagnostics?.push({
      code: "direct_success",
      url: config.listingUrls[0],
      message: `Kept ${results.length} open notices${skippedSummary ? `; skipped ${skippedSummary}` : ""}.`,
      method: "direct",
    });
    return results;
  }

  /**
   * robots.txt rules: a missing file (404) means no restrictions were
   * published; any other failure means we cannot verify, so we do not crawl.
   */
  private async loadRobots(): Promise<(url: string) => boolean> {
    const { config } = this;
    const robots = await this.fetchText(`${config.origin}/robots.txt`, 256_000, {
      headers: { Accept: "text/plain" },
    });
    if (robots.response.status === 404 || robots.response.status === 410) return () => true;
    const contentType = robots.response.headers.get("content-type") ?? "";
    if (!robots.response.ok || !/^text\/plain\b/i.test(contentType)) {
      throw new Error(`${config.label} robots.txt could not be verified (HTTP ${robots.response.status}); refusing to crawl.`);
    }
    return (url: string) => robotsPathAllowed(robots.text, new URL(url).pathname);
  }

  private async readDetail(
    url: string,
    robotsAllows: (url: string) => boolean,
  ): Promise<{
    content: string;
    status: string;
    documents: Array<{ url: string; format: "pdf" | "docx" | "unsupported"; status: "extracted" | "scanned_or_textless" | "fetch_failed" | "malformed" | "unsupported" | "blocked_by_robots"; characters: number; extractedText?: string }>;
  }> {
    if (!robotsAllows(url)) return { content: "", status: "blocked_by_robots", documents: [] };
    if (/\.(?:pdf|docx)(?:[?#]|$)/i.test(url)) {
      // The notice itself is a document: its text is the scope.
      const escaped = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
      const documents = await extractProcurementDocuments(
        `<a href="${escaped}">tender notice document</a>`,
        url,
        this.config.approvedDomains,
        (documentUrl, domains, maxBytes) => this.fetchBytes(documentUrl, domains, maxBytes),
      );
      const text = (documents[0]?.text ?? "").replace(/\s+/g, " ").trim();
      return {
        content: text,
        status: text ? "success" : (documents[0]?.status ?? "fetch_failed"),
        documents: documents.map(({ url: documentUrl, format, status, characters }) => ({
          url: documentUrl, format, status, characters,
        })),
      };
    }
    try {
      const detail = await this.fetchText(url, 1_000_000, {
        headers: { Accept: "text/html, application/xhtml+xml" },
      });
      if (!detail.response.ok) return { content: "", status: "fetch_failed", documents: [] };
      if (!/html|text/i.test(detail.response.headers.get("content-type") ?? "")) {
        return { content: "", status: "unsupported_content", documents: [] };
      }
      const documents = await extractProcurementDocuments(
        detail.text,
        url,
        this.config.approvedDomains,
        (documentUrl, domains, maxBytes) => this.fetchBytes(documentUrl, domains, maxBytes),
        undefined,
        async (documentUrl) => robotsAllows(documentUrl),
      );
      return {
        content: decodeEntities(extractNoticeContent(
          (detail.text.match(this.config.contentPattern ?? /^[\s\S]*$/)?.[0] ?? detail.text)
            .replace(/<svg\b[\s\S]*?<\/svg>/gi, " "),
        )),
        status: "success",
        documents: documents.map(({ url: documentUrl, format, status, characters, text }) => ({
          url: documentUrl, format, status, characters,
          ...(text ? { extractedText: text.slice(0, 4_000) } : {}),
        })),
      };
    } catch {
      return { content: "", status: "fetch_failed", documents: [] };
    }
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
      return await fetchApprovedText(url, this.config.approvedDomains, maxBytes, options);
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

// ── Sources ──────────────────────────────────────────────────────────────────
// Each was checked live on 2026-11-20: robots.txt permits the paths (or none is
// published), the listing is public, and no login or CAPTCHA is involved.
export const LISTING_SOURCES: readonly ListingSourceConfig[] = [
  {
    adapterType: "bermuda_gov",
    label: "Government of Bermuda Procurement",
    organization: "Government of Bermuda",
    country: "Bermuda (Caribbean region)",
    sector: "Government Procurement",
    origin: "https://www.gov.bm",
    listingUrls: ["https://www.gov.bm/procurement-notices"],
    approvedDomains: ["gov.bm"],
    blockPattern: /<h3 class="public-procurement-result-title">[\s\S]*?(?=<h3 class="public-procurement-result-title">|<nav\b|<footer\b|$)/g,
    noticePath: /^\/procurement-notices\/[^/]+/,
    maxUndatedAgeDays: 120,
  },
  {
    adapterType: "central_bank_bahamas",
    label: "Central Bank of The Bahamas Procurement",
    organization: "Central Bank of The Bahamas",
    country: "Bahamas",
    sector: "Financial Services / Government",
    origin: "https://www.centralbankbahamas.com",
    listingUrls: ["https://www.centralbankbahamas.com/news/public-procurement"],
    approvedDomains: ["centralbankbahamas.com"],
    blockPattern: /<div class="date-info">[\s\S]*?<h2 class="title">[\s\S]*?<\/h2>/g,
    noticePath: /^\/news\/public-procurement\/[^/]+/,
    skipBlock: /award\s+announcement|notice\s+of\s+award/i,
    contentPattern: /<div class="newsdetails-page[\s\S]*?(?=<footer\b|$)/i,
    maxUndatedAgeDays: 120,
  },
  {
    adapterType: "compete_caribbean",
    label: "Compete Caribbean Opportunities",
    organization: "Compete Caribbean Partnership Facility",
    country: "Caribbean",
    sector: "Private Sector Development",
    origin: "https://www.competecaribbean.org",
    listingUrls: ["https://www.competecaribbean.org/opportunities/?state=open"],
    approvedDomains: ["competecaribbean.org"],
    blockPattern: /<article class="cc-card">[\s\S]*?<\/article>/g,
    noticePath: /^\/opportunities\/[^/]+/,
    skipBlock: /cc-opp-state--closed|cc-card__group">\s*Vacancy/i,
    maxUndatedAgeDays: 120,
  },
  {
    adapterType: "ccreee",
    label: "CCREEE Procurement (Caribbean energy centre)",
    organization: "Caribbean Centre for Renewable Energy and Energy Efficiency",
    country: "Caribbean",
    sector: "Energy / Regional Agency",
    origin: "https://www.ccreee.org",
    listingUrls: ["https://www.ccreee.org/all-procurements/"],
    approvedDomains: ["ccreee.org"],
    blockPattern: /<section>\s*<div class="inside">[\s\S]*?<\/section>/g,
    noticePath: /^\/procurements\/[^/]+/,
    maxUndatedAgeDays: 120,
  },
  {
    adapterType: "bermuda_tourism",
    label: "Bermuda Tourism Authority RFPs",
    organization: "Bermuda Tourism Authority",
    country: "Bermuda (Caribbean region)",
    sector: "Tourism / Destination Marketing",
    origin: "https://www.gotobermuda.com",
    listingUrls: ["https://www.gotobermuda.com/bta/rfp"],
    approvedDomains: ["gotobermuda.com"],
    // The page is a short list of links to RFP documents.
    blockPattern: /<a\b[^>]*href=["'][^"']*\/sites\/default\/files\/[^"']+\.(?:pdf|docx)["'][^>]*>[\s\S]*?<\/a>/gi,
    noticePath: /^\/sites\/default\/files\/.+\.(?:pdf|docx)$/i,
    postedFromUrl: /\/files\/(20\d{2})-(\d{2})\//,
    titlePrefix: /^(?:view|download|read)\s+(?:the\s+)?/i,
    maxUndatedAgeDays: 120,
  },
  {
    adapterType: "turks_caicos_gov",
    label: "Turks and Caicos Government Tenders",
    organization: "Turks and Caicos Islands Government",
    country: "Turks and Caicos (Caribbean)",
    sector: "Government Procurement",
    origin: "https://gov.tc",
    listingUrls: ["https://gov.tc/publicservice/government-tenders"],
    approvedDomains: ["gov.tc"],
    blockPattern: /<tr class="cat-list-row\d+"[\s\S]*?<\/tr>/g,
    noticePath: /^\/publicservice\/government-tenders\/[^/]+/,
    maxUndatedAgeDays: 120,
  },
  {
    adapterType: "belize_gov",
    label: "Belize Government Procurement Portal",
    organization: "Government of Belize",
    country: "Belize (Caribbean)",
    sector: "Government Procurement",
    origin: "https://procurement.gov.bz",
    listingUrls: ["https://procurement.gov.bz/opportunities/"],
    approvedDomains: ["procurement.gov.bz"],
    blockPattern: /<tr id="post-row-\d+"[\s\S]*?<\/tr>/g,
    noticePath: /^\/(?!category\/|opportunities\/?$)[^/]+\/?$/,
    skipBlock: /<a\b[^>]*>\s*Expired:/i,
    maxUndatedAgeDays: 120,
  },
] as const;

export function getListingSource(adapterType: string): ListingSourceConfig | undefined {
  return LISTING_SOURCES.find((source) => source.adapterType === adapterType);
}
