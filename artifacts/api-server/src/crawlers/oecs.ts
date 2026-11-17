import {
  TenderSourceAdapter, TenderOpportunity, fetchListingHtml, stripHtml,
  absoluteUrl, stableId,
} from "./base-adapter.js";

// Organisation of Eastern Caribbean States — "Current Tenders" (verified Nov 2026).
// The page is a list of documents; each has a title link and a "Details" page.
// The runner opens the Details page (and its attached document) for the scope.
const LISTING_URL = "https://www.oecs.int/en/work-with-us/procurements/current-tenders";

const COUNTRY_RX =
  /(Saint Lucia|St\.? Lucia|Grenada|Dominica|Antigua and Barbuda|Saint Vincent and the Grenadines|St\.? Vincent|Saint Kitts and Nevis|St\.? Kitts|Montserrat|Anguilla|British Virgin Islands|Martinique|Guadeloupe)/i;

export class OECSAdapter implements TenderSourceAdapter {
  adapterType = "oecs";

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    const html = await fetchListingHtml(LISTING_URL);
    const blocks = html.split(/<div class="edocman-document\b/i).slice(1);
    if (blocks.length === 0) {
      throw new Error("OECS tenders page loaded but no tender entries were recognised — layout may have changed");
    }

    const results: TenderOpportunity[] = [];
    const seen = new Set<string>();

    for (const block of blocks) {
      const titleMatch = block.match(
        /<a[^>]+class="edocman-document-title-link"[^>]*>([\s\S]*?)<\/a>/i,
      ) ?? block.match(/<h3[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i);
      const title = titleMatch ? stripHtml(titleMatch[1], 300) : "";
      if (title.length < 8) continue;

      const details = block.match(/<a\s+href="([^"]+)"[^>]*aria-label="Details"/i)?.[1];
      const titleHref = block.match(/<a\s+href="([^"]+)"[^>]*class="edocman-document-title-link"/i)?.[1];
      const href = details ?? titleHref;
      if (!href) continue;

      const url = absoluteUrl(href, LISTING_URL);
      if (seen.has(url)) continue;
      seen.add(url);

      results.push({
        externalId: stableId("oecs", url),
        title,
        organization: "OECS Commission",
        url,
        // Headline-only for now; replaced with the real notice text by the runner.
        description: `OECS tender notice: ${title}`,
        country: title.match(COUNTRY_RX)?.[1] ?? "Eastern Caribbean",
        sector: "Regional Procurement",
      });
    }

    return results;
  }
}
