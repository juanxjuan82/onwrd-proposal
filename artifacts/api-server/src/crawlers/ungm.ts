import { TenderSourceAdapter, TenderOpportunity, safeFetch, stripHtml } from "./base-adapter.js";

// Replaces the non-functional UNGM scraper with UNDP Procurement Notices,
// which has server-rendered HTML and notice listings accessible without JS.
export class UNGMAdapter implements TenderSourceAdapter {
  adapterType = "ungm";

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    const results: TenderOpportunity[] = [];

    try {
      const r = await safeFetch("https://procurement-notices.undp.org/", {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; TenderBot/1.0)",
          Accept: "text/html",
        },
      });
      if (!r.ok) return results;

      const html = await r.text();

      // Extract notice links: href="view_notice.cfm?notice_id=XXXXX"
      const linkPattern =
        /<a[^>]+href="(view_notice\.cfm\?notice_id=(\d+))"[^>]*>([\s\S]*?)<\/a>/gi;
      let match;
      const seen = new Set<string>();

      while ((match = linkPattern.exec(html)) !== null) {
        const path = match[1];
        const noticeId = match[2];
        // Strip leading "Title" label that appears in UNDP table cells
        const rawTitle = stripHtml(match[3], 250).replace(/^Title\s+/i, "").trim();

        if (!noticeId || !rawTitle || rawTitle.length < 8) continue;
        if (seen.has(noticeId)) continue;
        seen.add(noticeId);

        results.push({
          externalId: `undp-${noticeId}`,
          title: rawTitle,
          organization: "UNDP",
          url: `https://procurement-notices.undp.org/${path}`,
          description: `UNDP procurement notice: ${rawTitle}`,
          country: "International",
          sector: "United Nations",
        });

        if (results.length >= 30) break;
      }
    } catch {
      /* return empty on failure */
    }

    return results;
  }
}
