import {
  TenderSourceAdapter, TenderOpportunity, fetchListingHtml, stripHtml,
  parseLooseDate, absoluteUrl, stableId,
} from "./base-adapter.js";

// Caribbean Development Bank — the real procurement listings (verified Nov 2026).
// Each is a table: Role/Service | Sector | Country | Type | Deadline.
const LISTING_URLS = [
  "https://www.caribank.org/work-with-us/procurement/procurement-notices",
  "https://www.caribank.org/work-with-us/procurement/general-procurement-notices",
];

function td(row: string, fieldClass: string): string {
  const m = row.match(new RegExp(`<td[^>]*${fieldClass}[^>]*>([\\s\\S]*?)</td>`, "i"));
  return m ? stripHtml(m[1], 300) : "";
}

export class CDBAdapter implements TenderSourceAdapter {
  adapterType = "cdb";

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    const results: TenderOpportunity[] = [];
    const seen = new Set<string>();
    let okPages = 0;
    let lastError: Error | undefined;

    for (const listingUrl of LISTING_URLS) {
      let html: string;
      try {
        html = await fetchListingHtml(listingUrl);
        okPages++;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        continue;
      }

      const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
      let match: RegExpExecArray | null;
      while ((match = rowPattern.exec(html)) !== null) {
        const row = match[1];
        const link = row.match(
          /<a[^>]+href="([^"]*\/procurement\/(?:general-)?procurement-notices\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i,
        );
        if (!link) continue;

        const url = absoluteUrl(link[1], listingUrl);
        if (seen.has(url)) continue;
        seen.add(url);

        const title = stripHtml(link[2], 300);
        if (title.length < 8) continue;

        const sector = td(row, "sector-tag");
        const country = td(row, "country-tag").replace(/^The\s+/i, "");
        const type = td(row, "contract-awards-type");
        const deadline = parseLooseDate(td(row, "date-of-approval"));

        results.push({
          externalId: stableId("cdb", url),
          title,
          organization: "Caribbean Development Bank",
          url,
          deadline,
          // Headline-only for now; replaced with the real notice text by the runner.
          description: `Caribbean Development Bank procurement notice: ${title}`,
          country: country || "Caribbean",
          sector: [type, sector].filter(Boolean).join(" — ") || "Development Finance",
        });
      }
    }

    if (okPages === 0 && lastError) throw lastError;
    return results;
  }
}
