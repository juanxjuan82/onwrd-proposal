import {
  TenderSourceAdapter,
  TenderOpportunity,
  extractDeadline,
  extractListingContext,
  hasSubstantiveScope,
  resolveNoticeUrl,
  stripHtml,
} from "./base-adapter.js";

const APPROVED_HOSTS = ["caricom.org"];
const PROCUREMENT_PATH = /\/(?:procurement(?:-notices)?|tenders?)(?:\/|$)/i;

/**
 * Pure parser retained for fixture validation and future authorized feeds.
 * It accepts only links on procurement/tender paths and only keeps bounded
 * card/row context; it never creates a synthetic opportunity description.
 */
export function parseCaricomListing(
  html: string,
  sourcePage = "https://caricom.org/procurement-notices/",
): TenderOpportunity[] {
  const results: TenderOpportunity[] = [];
  const seen = new Set<string>();
  const anchors = /<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchors.exec(html)) && results.length < 15) {
    const title = stripHtml(match[3], 250);
    const url = resolveNoticeUrl(match[2], sourcePage, APPROVED_HOSTS);
    if (!url || !PROCUREMENT_PATH.test(new URL(url).pathname)) continue;
    if (
      title.length < 12
      || /^(?:read more|view details|click here)$/i.test(title)
      || /^(?:(?:open|past|current|closed|archived)\s+)?(?:procurement|tender|bid)?\s*notices?$/i.test(title)
    ) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const listingContext = extractListingContext(html, match.index, 1_500);
    const substantive = hasSubstantiveScope(listingContext, title);
    const deadline = extractDeadline(listingContext);
    results.push({
      externalId: `caricom-${new URL(url).pathname.split("/").filter(Boolean).pop()}`,
      title,
      organization: "CARICOM Secretariat",
      url,
      ...(deadline ? { deadline } : {}),
      description: substantive ? listingContext : "",
      country: "Caribbean",
      sector: "Government & Public Communications",
      rawData: {
        sourcePage,
        noticeUrl: url,
        listingContext,
        extractionMethod: "source_specific_listing_card",
        detailFetchStatus: "not_attempted_robots_policy",
        descriptionStatus: substantive ? "substantive" : "insufficient_scope",
        documentStatus: "not_checked",
        ...(substantive ? {} : { needsEnrichment: true }),
      },
    });
  }
  return results;
}

export class CARICOMAdapter implements TenderSourceAdapter {
  adapterType = "caricom";

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    // robots.txt currently disallows /, including procurement-notices. Fail
    // closed before making a notice-page request; fixtures exercise the parser.
    throw new Error("CARICOM source disabled: robots.txt disallows all notice paths. Do not crawl without explicit authorization.");
  }
}
