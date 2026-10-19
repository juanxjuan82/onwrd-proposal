import {
  TenderSourceAdapter,
  TenderOpportunity,
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

const CDB_ORIGIN = "https://www.caribank.org";
const CDB_LISTING_URL = `${CDB_ORIGIN}/work-with-us/procurement/procurement-notices`;
const CDB_APPROVED_DOMAINS = ["caribank.org"];
const MAX_NOTICES_PER_RUN = 5;

export class CDBAdapter implements TenderSourceAdapter {
  adapterType = "cdb";
  private lastRequestCompletedAt = 0;

  constructor(private readonly requestIntervalMs = 1_000) {}

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    const robots = await this.fetchText(`${CDB_ORIGIN}/robots.txt`, 256_000, {
      headers: { Accept: "text/plain" },
    });
    if (!robots.response.ok || !/^text\/plain\b/i.test(robots.response.headers.get("content-type") ?? "")) {
      throw new Error(`CDB robots.txt could not be verified (HTTP ${robots.response.status}); refusing to crawl.`);
    }
    const robotsText = robots.text;
    const robotsAllows = async (url: string) =>
      robotsPathAllowed(robotsText, new URL(url).pathname);
    if (!await robotsAllows(CDB_LISTING_URL)) {
      throw new Error("CDB robots.txt disallows the procurement-notices listing path.");
    }

    const listing = await this.fetchText(
      CDB_LISTING_URL,
      2_000_000,
      { headers: { Accept: "text/html" } },
    );
    if (!listing.response.ok) {
      throw new Error(`CDB procurement-notices listing returned HTTP ${listing.response.status}.`);
    }

    const results: TenderOpportunity[] = [];
    const seen = new Set<string>();
    const anchors = /<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;
    while ((match = anchors.exec(listing.text)) && results.length < MAX_NOTICES_PER_RUN) {
      const rawTitle = stripHtml(match[3], 250);
      if (rawTitle.length < 8) continue;
      const noticeUrl = resolveNoticeUrl(match[2], CDB_LISTING_URL, CDB_APPROVED_DOMAINS);
      if (!noticeUrl) continue;
      const noticePath = new URL(noticeUrl).pathname;
      if (!noticePath.startsWith("/work-with-us/procurement/procurement-notices/")) continue;
      const dedupeKey = noticeUrl.replace(/\/+$/, "").toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const linkStart = match.index;
      const blockStart = Math.max(
        listing.text.lastIndexOf("<article", linkStart),
        listing.text.lastIndexOf("<tr", linkStart),
      );
      const articleEnd = listing.text.indexOf("</article>", linkStart);
      const rowEnd = listing.text.indexOf("</tr>", linkStart);
      const blockEnd = articleEnd >= 0 && (rowEnd < 0 || articleEnd < rowEnd)
        ? articleEnd + "</article>".length
        : rowEnd >= 0
          ? rowEnd + "</tr>".length
          : -1;
      const listingContext = blockStart >= 0 && blockEnd > blockStart
        ? stripHtml(listing.text.slice(blockStart, blockEnd), 1_500)
        : rawTitle;
      let detailHtml = "";
      let detailFetchStatus = "fetch_failed";
      let documents: Awaited<ReturnType<typeof extractProcurementDocuments>> = [];
      if (await robotsAllows(noticeUrl)) {
        try {
          const detail = await this.fetchText(
            noticeUrl,
            1_000_000,
            { headers: { Accept: "text/html, application/xhtml+xml" } },
          );
          if (detail.response.ok && /html|text/i.test(detail.response.headers.get("content-type") ?? "")) {
            detailHtml = detail.text;
            documents = await extractProcurementDocuments(
              detailHtml,
              noticeUrl,
              CDB_APPROVED_DOMAINS,
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
      } else {
        detailFetchStatus = "blocked_by_robots";
      }

      const detailContent = detailHtml ? extractNoticeContent(detailHtml) : "";
      const documentMetadata = documents.map(({ url, format, status, characters, text }) => ({
        url,
        format,
        status,
        characters,
        ...(text ? { extractedText: text.slice(0, 4_000) } : {}),
      }));
      const combined = prioritizeDocumentContent(detailContent, documentMetadata, 4_000);
      const detailHasScope = hasSubstantiveScope(combined, rawTitle);
      const listingHasScope = hasSubstantiveScope(listingContext, rawTitle);
      const description = detailHasScope ? combined : listingHasScope ? listingContext : "";
      const descriptionStatus = description ? "substantive" : "insufficient_scope";
      const documentStatus = documents.length === 0
        ? "none_found"
        : documents.some((document) => document.status === "extracted")
          ? "extracted"
          : documents.map((document) => document.status).join(",");

      results.push({
        externalId: `cdb-${Buffer.from(noticePath).toString("base64url").slice(0, 32)}`,
        title: rawTitle,
        organization: "Caribbean Development Bank",
        url: noticeUrl,
        deadline: extractDeadline(`${listingContext}\n${detailContent}`),
        description,
        country: "Caribbean",
        sector: "Development Finance",
        rawData: {
          sourcePage: CDB_LISTING_URL,
          noticeUrl,
          listingContext,
          extractionMethod: detailHasScope ? "direct_detail" : "listing_context",
          detailFetchStatus,
          descriptionStatus,
          documentStatus,
          documentExtraction: documentMetadata,
          documentUrls: documentMetadata.map((document) => document.url),
          ...(description ? {} : { needsEnrichment: true }),
        },
      });
    }
    return results;
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
      return await fetchApprovedText(url, CDB_APPROVED_DOMAINS, maxBytes, options);
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
