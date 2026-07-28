import { TenderSourceAdapter, TenderOpportunity, safeFetch, stripHtml } from "./base-adapter.js";

// UNDP Procurement Notices adapter.
// Uses procurement-notices.undp.org which has server-rendered HTML listings
// accessible without JS. Extracts surrounding table row context for each
// notice to produce descriptions that pass the eligibility content-quality gate.
export class UNGMAdapter implements TenderSourceAdapter {
  adapterType = "ungm";

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    const results: TenderOpportunity[] = [];

    const r = await safeFetch("https://procurement-notices.undp.org/", {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; TenderBot/1.0)",
        Accept: "text/html",
      },
    });
    if (!r.ok) {
      throw new Error(`UNGM: HTTP ${r.status} from procurement-notices.undp.org`);
    }

    try {
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

        // Extract surrounding row context for a real description.
        // The UNDP listing is a table; the ~600 chars around the link include
        // other columns: country, procurement type, closing date, agency, etc.
        // Stripping HTML from that window produces a description that has
        // genuine content rather than a template stub.
        const linkPos = html.indexOf(`notice_id=${noticeId}`);
        let description = `UNDP procurement notice: ${rawTitle}`;
        if (linkPos > 0) {
          const windowStart = Math.max(0, linkPos - 300);
          const windowEnd = Math.min(html.length, linkPos + 500);
          const contextText = stripHtml(html.slice(windowStart, windowEnd), 600)
            .replace(/\s+/g, " ")
            .trim();
          // Only use the context if it adds real content beyond repeating the title
          if (contextText.length > rawTitle.length + 80) {
            description = contextText.slice(0, 500);
          }
        }

        // Detect Caribbean/Bahamas mentions in title + description for geo scoring
        const corpus = `${rawTitle} ${description}`.toLowerCase();
        const country =
          corpus.includes("bahamas")   ? "Bahamas" :
          corpus.includes("caribbean") ? "Caribbean" :
          corpus.includes("jamaica")   ? "Jamaica" :
          corpus.includes("barbados")  ? "Barbados" :
          corpus.includes("trinidad")  ? "Trinidad and Tobago" :
          corpus.includes("guyana")    ? "Guyana" :
          corpus.includes("belize")    ? "Belize" :
          "International";

        results.push({
          externalId: `undp-${noticeId}`,
          title: rawTitle,
          organization: "UNDP",
          url: `https://procurement-notices.undp.org/${path}`,
          description,
          country,
          sector: "United Nations",
        });

        if (results.length >= 30) break;
      }
    } catch (err) {
      throw new Error(`UNGM: failed to parse procurement-notices.undp.org response: ${err instanceof Error ? err.message : String(err)}`);
    }

    return results;
  }
}
