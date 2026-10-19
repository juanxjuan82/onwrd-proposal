import {
  TenderSourceAdapter,
  TenderOpportunity,
  assertRobotsAllows,
  extractDeadline,
  extractListingContext,
  fetchApprovedBytes,
  fetchNoticeDetailResult,
  hasSubstantiveScope,
  resolveNoticeUrl,
  stripHtml,
} from "./base-adapter.js";

const LISTING_URL = "https://www.caribank.org/work-with-us/procurement/procurement-notices";
const APPROVED_HOSTS = ["caribank.org"];
const NOTICE_PATH_PREFIX = "/work-with-us/procurement/procurement-notices/";

// CDB's public procurement listing is robots-allowed. Keep non-procurement
// news and project pages out of this adapter so they cannot become fake notices.
export class CDBAdapter implements TenderSourceAdapter {
  adapterType = "cdb";

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    await assertRobotsAllows(LISTING_URL);
    const { response, bytes } = await fetchApprovedBytes(LISTING_URL, APPROVED_HOSTS, 2_000_000);
    if (!response.ok) {
      throw new Error(`CDB procurement listing returned HTTP ${response.status}.`);
    }
    const html = new TextDecoder().decode(bytes);

    const opportunities: TenderOpportunity[] = [];
    const seen = new Set<string>();
    const anchorPattern = /<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;
    while ((match = anchorPattern.exec(html)) && opportunities.length < 10) {
      const title = stripHtml(match[3], 250);
      const url = resolveNoticeUrl(match[2], LISTING_URL, APPROVED_HOSTS);
      if (!url || !new URL(url).pathname.startsWith(NOTICE_PATH_PREFIX)) continue;
      if (title.length < 12 || /^(?:read more|view details|procurement notices?|click here)$/i.test(title)) continue;
      if (seen.has(url)) continue;
      seen.add(url);

      const listingContext = extractListingContext(html, match.index, 1_500);
      const detail = await fetchNoticeDetailResult(url, title, APPROVED_HOSTS);
      const description = detail.status === "substantive"
        ? detail.content
        : hasSubstantiveScope(listingContext, title) ? listingContext : "";
      const descriptionStatus = hasSubstantiveScope(description, title)
        ? "substantive"
        : "insufficient_scope";
      const deadline = extractDeadline(`${description} ${listingContext}`);

      opportunities.push({
        externalId: `cdb-${new URL(url).pathname.split("/").filter(Boolean).pop()}`,
        title,
        organization: "Caribbean Development Bank",
        url,
        ...(deadline ? { deadline } : {}),
        description,
        country: "Caribbean",
        sector: "Development Finance",
        rawData: {
          sourcePage: LISTING_URL,
          noticeUrl: url,
          listingContext,
          extractionMethod: detail.status === "substantive" ? "detail_html_or_document" : "listing_context",
          detailFetchStatus: detail.status,
          descriptionStatus,
          documentStatus: detail.status === "fetch_failed"
            ? "not_checked"
            : detail.documents.length ? "documents_found" : "none_found",
          documentExtraction: detail.documents,
          ...(descriptionStatus !== "substantive" ? { needsEnrichment: true } : {}),
        },
      });
    }
    return opportunities;
  }
}
