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
  robotsPathAllowed,
  resolveNoticeUrl,
  stripHtml,
} from "./base-adapter.js";

const CARICOM_ORIGIN = "https://caricom.org";
const CARICOM_ROBOTS_URL = `${CARICOM_ORIGIN}/robots.txt`;
const CARICOM_SOURCE_PAGE = `${CARICOM_ORIGIN}/procurement-notices/`;
const CARICOM_NOTICE_HOSTS = ["caricom.org"];
const MAX_NOTICES_PER_RUN = 5;

function makeOpportunity(
  title: string,
  noticeUrl: string,
  listingContext: string,
  deadline: Date | undefined,
  publishedDate?: string,
  closingDate?: string,
  extractionMethod = "caricom_listing_table",
): TenderOpportunity {
  const path = new URL(noticeUrl).pathname;
  const substantiveListing = hasSubstantiveScope(listingContext, title);
  const description = substantiveListing ? listingContext : "";
  return {
    externalId: `caricom-${Buffer.from(path).toString("base64url").slice(0, 32)}`,
    title,
    organization: "CARICOM Secretariat",
    url: noticeUrl,
    deadline,
    description,
    country: "Caribbean",
    sector: "Government & Public Communications",
    rawData: {
      sourcePage: CARICOM_SOURCE_PAGE,
      noticeUrl,
      listingContext,
      extractionMethod,
      descriptionStatus: description ? "substantive" : "insufficient_scope",
      detailFetchStatus: "not_fetched",
      documentStatus: "not_fetched",
      documentUrls: [],
      ...(publishedDate ? { publishedDate } : {}),
      ...(closingDate ? { closingDate } : {}),
    },
  };
}

function parseCaricomTable(html: string): TenderOpportunity[] {
  const table = html.match(/<table\b(?=[^>]*\bid=(["'])table_id\1)[\s\S]*?<\/table>/i)?.[0];
  if (!table) return [];
  const results: TenderOpportunity[] = [];
  const seen = new Set<string>();
  for (const rowMatch of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rowMatch[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((match) => match[1]);
    if (cells.length < 3) continue;
    const anchor = cells[0].match(/<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const title = stripHtml(anchor[3], 250);
    if (title.length < 8) continue;
    const noticeUrl = resolveNoticeUrl(anchor[2], CARICOM_SOURCE_PAGE, CARICOM_NOTICE_HOSTS);
    if (!noticeUrl || !new URL(noticeUrl).pathname.startsWith("/procurement/")) continue;
    const dedupeKey = noticeUrl.replace(/\/+$/, "").toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const publishedDate = stripHtml(cells[1], 80);
    const closingDate = stripHtml(cells[2], 80);
    const listingContext = stripHtml(cells.slice(0, 3).join(" "), 1_500);
    results.push(makeOpportunity(
      title,
      noticeUrl,
      listingContext,
      extractDeadline(`Closing Date: ${closingDate}`),
      publishedDate,
      closingDate,
    ));
  }
  return results;
}

/** Parse CARICOM's current #table_id notice rows, plus source-specific fixture cards. */
export function parseCaricomListing(html: string): TenderOpportunity[] {
  const tableRows = parseCaricomTable(html);
  if (tableRows.length) return tableRows;

  const blocks = [
    ...html.matchAll(/<article\b[^>]*>[\s\S]*?<\/article>/gi),
    ...html.matchAll(/<div\b[^>]*class=(["'])[^"']*procurement-card[^"']*\1[^>]*>[\s\S]*?<\/div>/gi),
  ];
  const results: TenderOpportunity[] = [];
  const seen = new Set<string>();
  for (const blockMatch of blocks) {
    const block = blockMatch[0];
    const anchor = block.match(/<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const title = stripHtml(anchor[3], 250);
    const noticeUrl = resolveNoticeUrl(anchor[2], CARICOM_SOURCE_PAGE, CARICOM_NOTICE_HOSTS);
    if (
      title.length < 8 ||
      !noticeUrl ||
      !new URL(noticeUrl).pathname.startsWith("/procurement/") ||
      seen.has(noticeUrl)
    ) continue;
    seen.add(noticeUrl);
    const listingContext = extractNoticeContent(block);
    const deadline = extractDeadline(listingContext);
    const opportunity = makeOpportunity(
      title,
      noticeUrl,
      listingContext,
      deadline,
      undefined,
      undefined,
      "fixture_listing",
    );
    const documentUrls: string[] = [];
    const documentLinks = /<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
    let documentMatch: RegExpExecArray | null;
    while ((documentMatch = documentLinks.exec(block)) && documentUrls.length < 3) {
      if (!/\.(?:pdf|docx|doc)(?:[?#]|$)/i.test(documentMatch[2])) continue;
      if (!/(?:tor|terms|reference|tender|procurement|rfp|scope|notice)/i.test(`${documentMatch[2]} ${documentMatch[3]}`)) continue;
      const documentUrl = resolveNoticeUrl(documentMatch[2], noticeUrl, CARICOM_NOTICE_HOSTS);
      if (documentUrl && !documentUrls.includes(documentUrl)) documentUrls.push(documentUrl);
    }
    results.push({
      ...opportunity,
      rawData: {
        ...opportunity.rawData,
        documentStatus: documentUrls.length ? "not_fetched" : "none_found",
        documentUrls,
      },
    });
  }
  return results;
}

export class CARICOMAdapter implements TenderSourceAdapter {
  adapterType = "caricom";
  private lastRequestCompletedAt = 0;

  constructor(private readonly requestIntervalMs = 1_000) {}

  async fetchOpportunities(_context?: AdapterFetchContext): Promise<TenderOpportunity[]> {
    const robots = await this.fetchText(CARICOM_ROBOTS_URL, 256_000, {
      headers: { Accept: "text/plain" },
    });
    if (!robots.response.ok || !/^text\/plain\b/i.test(robots.response.headers.get("content-type") ?? "")) {
      throw new Error(`CARICOM robots.txt could not be verified (HTTP ${robots.response.status}); refusing to crawl.`);
    }
    const robotsAllows = async (url: string) =>
      robotsPathAllowed(robots.text, new URL(url).pathname);
    if (!await robotsAllows(CARICOM_SOURCE_PAGE)) {
      throw new Error("CARICOM robots.txt disallows the procurement-notices listing path.");
    }

    const listing = await this.fetchText(CARICOM_SOURCE_PAGE, 2_000_000, {
      headers: { Accept: "text/html" },
    });
    if (!listing.response.ok || !/html/i.test(listing.response.headers.get("content-type") ?? "")) {
      throw new Error(`CARICOM procurement-notices listing returned HTTP ${listing.response.status}.`);
    }

    const opportunities = parseCaricomListing(listing.text).slice(0, MAX_NOTICES_PER_RUN);
    const enriched: TenderOpportunity[] = [];
    for (const opportunity of opportunities) {
      const noticeUrl = opportunity.url;
      if (!noticeUrl || !await robotsAllows(noticeUrl)) {
        enriched.push(this.withFetchFailure(opportunity, "blocked_by_robots"));
        continue;
      }
      let detailHtml = "";
      let detailFetchStatus = "fetch_failed";
      let documents: Awaited<ReturnType<typeof extractProcurementDocuments>> = [];
      try {
        const detail = await this.fetchText(noticeUrl, 1_000_000, {
          headers: { Accept: "text/html, application/xhtml+xml" },
        });
        if (detail.response.ok && /html|text/i.test(detail.response.headers.get("content-type") ?? "")) {
          detailHtml = detail.text;
          documents = await extractProcurementDocuments(
            detailHtml,
            noticeUrl,
            CARICOM_NOTICE_HOSTS,
            (url, domains, maxBytes) => this.fetchBytes(url, domains, maxBytes),
            undefined,
            robotsAllows,
          );
          detailFetchStatus = "success";
        } else if (detail.response.ok) {
          detailFetchStatus = "unsupported_content";
        }
      } catch {
        detailFetchStatus = "fetch_failed";
      }

      const detailContent = detailHtml ? extractNoticeContent(detailHtml) : "";
      const documentExtraction = documents.map(({ url, format, status, characters, text }) => ({
        url,
        format,
        status,
        characters,
        ...(text ? { extractedText: text.slice(0, 4_000) } : {}),
      }));
      const combined = prioritizeDocumentContent(detailContent, documentExtraction, 4_000);
      const detailHasScope = hasSubstantiveScope(combined, opportunity.title);
      const listingContext = typeof opportunity.rawData?.listingContext === "string"
        ? opportunity.rawData.listingContext
        : "";
      const listingHasScope = hasSubstantiveScope(listingContext, opportunity.title);
      const description = detailHasScope ? combined : listingHasScope ? listingContext : "";
      const documentStatus = documents.length === 0
        ? "none_found"
        : documents.some((document) => document.status === "extracted")
          ? "extracted"
          : documents.map((document) => document.status).join(",");
      enriched.push({
        ...opportunity,
        description,
        deadline: opportunity.deadline ?? extractDeadline(detailContent),
        rawData: {
          ...opportunity.rawData,
          noticeUrl,
          detailFetchStatus,
          descriptionStatus: description ? "substantive" : "insufficient_scope",
          extractionMethod: detailHasScope ? "direct_detail" : listingHasScope ? "listing_table" : "insufficient_scope",
          documentStatus,
          documentExtraction,
          documentUrls: documentExtraction.map((document) => document.url),
          ...(!description ? { needsEnrichment: true } : {}),
        },
      });
    }
    return enriched;
  }

  private withFetchFailure(opportunity: TenderOpportunity, status: string): TenderOpportunity {
    return {
      ...opportunity,
      rawData: {
        ...opportunity.rawData,
        detailFetchStatus: status,
        descriptionStatus: opportunity.description ? "substantive" : "insufficient_scope",
        documentStatus: opportunity.rawData?.documentStatus ?? "not_fetched",
      },
    };
  }

  private async waitForNextRequest(): Promise<void> {
    if (this.lastRequestCompletedAt > 0 && this.requestIntervalMs > 0) {
      const remaining = this.requestIntervalMs - (Date.now() - this.lastRequestCompletedAt);
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  }

  private async fetchText(
    url: string,
    maxBytes: number,
    options: RequestInit,
  ): Promise<{ response: Response; text: string }> {
    await this.waitForNextRequest();
    try {
      return await fetchApprovedText(url, CARICOM_NOTICE_HOSTS, maxBytes, options);
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
