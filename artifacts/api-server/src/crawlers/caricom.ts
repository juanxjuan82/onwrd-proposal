import {
  TenderSourceAdapter, TenderOpportunity, fetchListingHtml, stripHtml,
  parseLooseDate, stableId,
} from "./base-adapter.js";

// CARICOM Secretariat — the "Current Notices" table (verified Nov 2026):
// Title of Notice | Date Published | Closing Date | Details
const LISTING_URL = "https://caricom.org/procurement-notices/";

export class CARICOMAdapter implements TenderSourceAdapter {
  adapterType = "caricom";

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    const html = await fetchListingHtml(LISTING_URL);
    if (!/Title of Notice/i.test(html) && !/open Procurement Notices/i.test(html)) {
      throw new Error("CARICOM procurement page loaded but the notices table was not found — layout may have changed");
    }

    const results: TenderOpportunity[] = [];
    const seen = new Set<string>();
    const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let match: RegExpExecArray | null;

    while ((match = rowPattern.exec(html)) !== null) {
      const cells = [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]);
      if (cells.length < 3) continue;

      const link = cells[0].match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!link) continue;
      const url = link[1];
      const title = stripHtml(link[2], 300);
      if (title.length < 8 || seen.has(url)) continue;
      seen.add(url);

      results.push({
        externalId: stableId("caricom", url),
        title,
        organization: "CARICOM Secretariat",
        url,
        deadline: parseLooseDate(stripHtml(cells[2], 80)),
        // Headline-only for now; replaced with the real notice text by the runner.
        description: `CARICOM Secretariat procurement notice: ${title}`,
        country: "Caribbean",
        sector: "Government & Public Communications",
        rawData: {
          published: stripHtml(cells[1], 80),
          adapterContext:
            "CARICOM procurement: regional Caribbean Community communications and public awareness work.",
        },
      });
    }

    return results;
  }
}
