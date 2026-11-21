import { stableExternalId } from "./dedup.js";
import {
  AdapterFetchContext,
  TenderOpportunity,
  TenderSourceAdapter,
  extractProcurementDocuments,
  fetchApprovedBytes,
  fetchApprovedText,
  robotsPathAllowed,
  stripHtml,
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

/**
 * A tourism board whose site runs on WordPress and publishes tenders as PDF
 * adverts and/or news posts. Both are read through WordPress's public feed.
 */
export interface WpFeedConfig {
  adapterType: string;
  label: string;
  organization: string;
  country: string;
  sector: string;
  origin: string;
  /** Page shown to people as "where this came from". */
  sourcePage: string;
  domains: readonly string[];
  /** Outside file stores the site keeps its uploads in (host + folder only). */
  fileStores: ReadonlyArray<{ host: string; pathPrefix: string }>;
  /** Also read news posts whose title is a tender (some boards post no PDF). */
  searchPosts: boolean;
}

export const JTB_FEED: WpFeedConfig = {
  adapterType: "jtb",
  label: "Jamaica Tourist Board",
  organization: "Jamaica Tourist Board",
  country: "Jamaica",
  sector: "Tourism / Government",
  origin: "https://www.jtbonline.org",
  sourcePage: "https://www.jtbonline.org/public-offerings/procurement/",
  domains: ["jtbonline.org"],
  // The media library stores its files in this bucket, under this folder only.
  fileStores: [{ host: "lcms-mysql-server.s3.us-east-2.amazonaws.com", pathPrefix: "/jtbonline.org/wp-content/uploads/" }],
  searchPosts: false,
};

// Belize Tourism Board: posts "Request for Expression of Interest – Marketing
// Representation Services in <market>" as news posts (2019, 2023) and keeps
// RFP documents in its own uploads folder.
export const BELIZE_TOURISM_FEED: WpFeedConfig = {
  adapterType: "belize_tourism",
  label: "Belize Tourism Board",
  organization: "Belize Tourism Board",
  country: "Belize (Caribbean)",
  sector: "Tourism / Government",
  origin: "https://www.belizetourismboard.org",
  sourcePage: "https://www.belizetourismboard.org/",
  domains: ["belizetourismboard.org"],
  fileStores: [],
  searchPosts: true,
};

export const WP_FEED_SOURCES: readonly WpFeedConfig[] = [JTB_FEED, BELIZE_TOURISM_FEED];
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
  content?: { rendered?: string };
}

export interface JtbAdvert {
  id: number;
  title: string;
  fileUrl: string;
  postedAt?: Date;
}

/** Keep only tender PDFs stored in the JTB's own file folder. */
export function selectJtbAdverts(items: readonly JtbMediaItem[]): JtbAdvert[] {
  return selectFeedAdverts(items, JTB_FEED);
}

function cleanTitle(raw: string | undefined): string {
  return decodeEntities(raw ?? "")
    .replace(/<[^>]+>/g, " ").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
}

function parseFeedDate(value: string | undefined): Date | undefined {
  const date = value ? new Date(`${value}Z`) : undefined;
  return date && !Number.isNaN(date.getTime()) ? date : undefined;
}

/** Keep only tender PDFs stored on the board's own site or file store. */
export function selectFeedAdverts(items: readonly JtbMediaItem[], config: WpFeedConfig): JtbAdvert[] {
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
    const onOwnSite = config.domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
    const inOwnFolder = config.fileStores.some((store) =>
      host === store.host && file.pathname.startsWith(store.pathPrefix));
    if (file.protocol !== "https:" || (!onOwnSite && !inOwnFolder)) continue;
    const title = cleanTitle(item.title?.rendered);
    if (!TENDER_TITLE.test(title) || NOT_A_TENDER.test(title)) continue;
    seen.add(item.id);
    adverts.push({ id: item.id, title, fileUrl: file.toString(), postedAt: parseFeedDate(item.date) });
  }
  return adverts.sort((a, b) => (b.postedAt?.getTime() ?? 0) - (a.postedAt?.getTime() ?? 0));
}

export interface FeedPost {
  id: number;
  title: string;
  url: string;
  text: string;
  postedAt?: Date;
}

/** Keep only news posts on the board's own site whose title is a tender. */
export function selectFeedPosts(items: readonly JtbMediaItem[], config: WpFeedConfig): FeedPost[] {
  const posts: FeedPost[] = [];
  const seen = new Set<number>();
  for (const item of items) {
    if (typeof item.id !== "number" || seen.has(item.id) || !item.link) continue;
    let link: URL;
    try {
      link = new URL(item.link);
    } catch {
      continue;
    }
    const host = link.hostname.toLowerCase();
    if (link.protocol !== "https:" ||
        !config.domains.some((domain) => host === domain || host.endsWith(`.${domain}`))) continue;
    const title = cleanTitle(item.title?.rendered);
    if (!TENDER_TITLE.test(title) || NOT_A_TENDER.test(title)) continue;
    seen.add(item.id);
    posts.push({
      id: item.id,
      title,
      url: link.toString(),
      text: decodeEntities(stripHtml(decodeEntities(item.content?.rendered ?? ""), 12_000)).replace(/\s+/g, " ").trim(),
      postedAt: parseFeedDate(item.date),
    });
  }
  return posts;
}

export class WpFeedAdapter implements TenderSourceAdapter {
  adapterType: string;
  private lastRequestCompletedAt = 0;

  constructor(
    protected readonly config: WpFeedConfig,
    private readonly requestIntervalMs = 1_000,
  ) {
    this.adapterType = config.adapterType;
  }

  async fetchOpportunities(context?: AdapterFetchContext): Promise<TenderOpportunity[]> {
    const { config } = this;
    const mediaApi = `${config.origin}/wp-json/wp/v2/media`;
    const postsApi = `${config.origin}/wp-json/wp/v2/posts`;
    const robots = await this.fetchText(`${config.origin}/robots.txt`, 256_000, { headers: { Accept: "text/plain" } });
    if (!robots.response.ok || !/^text\/plain\b/i.test(robots.response.headers.get("content-type") ?? "")) {
      throw new Error(`${config.label} robots.txt could not be verified (HTTP ${robots.response.status}); refusing to crawl.`);
    }
    if (!robotsPathAllowed(robots.text, new URL(mediaApi).pathname)) {
      throw new Error(`${config.label} robots.txt disallows the media feed path.`);
    }

    const now = new Date();
    const after = new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS).toISOString().slice(0, 19);
    const items: JtbMediaItem[] = [];
    const postItems: JtbMediaItem[] = [];
    const failures: string[] = [];
    let searchesSucceeded = 0;
    for (const term of SEARCH_TERMS) {
      const common = `search=${encodeURIComponent(term)}&after=${encodeURIComponent(after)}` +
        `&per_page=20&orderby=date&order=desc`;
      const searches: Array<{ url: string; into: JtbMediaItem[] }> = [{
        url: `${mediaApi}?${common}&mime_type=application/pdf&_fields=id,date,link,title,mime_type,source_url`,
        into: items,
      }];
      if (config.searchPosts) {
        searches.push({ url: `${postsApi}?${common}&_fields=id,date,link,title,content`, into: postItems });
      }
      for (const search of searches) {
        try {
          const page = await this.fetchText(search.url, 2_000_000, { headers: { Accept: "application/json" } });
          if (!page.response.ok) {
            failures.push(`"${term}": HTTP ${page.response.status}`);
            continue;
          }
          const parsed: unknown = JSON.parse(page.text);
          if (Array.isArray(parsed)) search.into.push(...(parsed as JtbMediaItem[]));
          searchesSucceeded++;
        } catch (error) {
          failures.push(`"${term}": ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    if (searchesSucceeded === 0) {
      throw new Error(`${config.label} feed: all searches failed. ${failures.join("; ")}`);
    }

    const results: TenderOpportunity[] = [];
    const skipped: Record<string, number> = {};
    const keep = (
      deadline: Date | undefined,
      postedAt: Date | undefined,
    ): boolean => {
      const rejection = listingRejection({ deadline, postedAt }, { maxUndatedAgeDays: MAX_UNDATED_AGE_DAYS }, now);
      if (rejection) skipped[rejection] = (skipped[rejection] ?? 0) + 1;
      return !rejection;
    };

    for (const post of selectFeedPosts(postItems, config)) {
      if (results.length >= MAX_NOTICES_PER_RUN) break;
      const deadline = readListingDeadline(post.text);
      if (!keep(deadline, post.postedAt)) continue;
      const hasText = post.text.length >= 120;
      results.push({
        externalId: stableExternalId(config.adapterType, post.url),
        title: post.title,
        organization: config.organization,
        url: post.url,
        deadline,
        description: hasText ? `${post.title}. ${post.text}`.slice(0, 4_000) : "",
        country: config.country,
        sector: config.sector,
        rawData: {
          sourcePage: config.sourcePage,
          postId: post.id,
          extractionMethod: "news_post",
          descriptionStatus: hasText ? "substantive" : "insufficient_scope",
          ...(post.postedAt ? { postedAt: post.postedAt.toISOString() } : {}),
          ...(hasText ? {} : { needsEnrichment: true }),
        },
      });
    }

    for (const advert of selectFeedAdverts(items, config)) {
      if (results.length >= MAX_NOTICES_PER_RUN) break;
      const escaped = advert.fileUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
      const documents = await extractProcurementDocuments(
        `<a href="${escaped}">tender notice document</a>`,
        advert.fileUrl,
        [...config.domains, ...config.fileStores.map((store) => store.host)],
        (url, domains, maxBytes) => this.fetchBytes(url, domains, maxBytes),
      );
      const document = documents[0];
      const text = (document?.text ?? "").replace(/\s+/g, " ").trim();
      const deadline = readListingDeadline(text);
      if (!keep(deadline, advert.postedAt)) continue;
      const hasText = text.length >= 120;
      results.push({
        externalId: stableExternalId(config.adapterType, advert.fileUrl),
        title: advert.title,
        organization: config.organization,
        url: advert.fileUrl,
        deadline,
        description: hasText ? `${advert.title}. ${text}`.slice(0, 4_000) : "",
        country: config.country,
        sector: config.sector,
        rawData: {
          sourcePage: config.sourcePage,
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
      url: mediaApi,
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
      return await fetchApprovedText(url, this.config.domains, maxBytes, options);
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

export class JTBAdapter extends WpFeedAdapter {
  constructor(requestIntervalMs = 1_000) {
    super(JTB_FEED, requestIntervalMs);
  }
}
