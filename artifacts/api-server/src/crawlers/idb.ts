import { TenderSourceAdapter, TenderOpportunity, safeFetch, stripHtml, stableId, absoluteUrl } from "./base-adapter.js";

export class IDBAdapter implements TenderSourceAdapter {
  adapterType = "idb";

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    const results: TenderOpportunity[] = [];
    let lastError: Error | undefined;
    let okPages = 0;

    const urls = [
      "https://www.iadb.org/en/projects/all?query=communications+marketing&country=BS,JM,TT,BB,GY,LC,VC",
      "https://www.iadb.org/en/projects/all?query=media+tourism+campaign&country=BS,JM,TT,BB",
    ];

    for (const url of urls) {
      try {
        const r = await safeFetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; TenderBot/1.0)",
            Accept: "text/html",
          },
        });
        if (!r.ok) { lastError = new Error(`${url} answered HTTP ${r.status}`); continue; }
        const html = await r.text();
        if (html.length < 500) { lastError = new Error(`${url} returned an empty page`); continue; }
        okPages++;

        const articlePattern = /<article[^>]*>([\s\S]*?)<\/article>/gi;
        let match;
        let count = 0;

        while ((match = articlePattern.exec(html)) !== null && count < 15) {
          const block = match[1];
          const titleMatch = block.match(/<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/i);
          const linkMatch = block.match(/href="([^"]*\/en\/project[^"]+)"/i);
          const title = titleMatch ? stripHtml(titleMatch[1], 200) : "";
          if (!title || title.length < 10) continue;

          const href = linkMatch ? linkMatch[1] : "";
          count++;
          results.push({
            externalId: stableId("idb", href || title),
            title,
            organization: "Inter-American Development Bank",
            url: href
              ? href.startsWith("http") ? href : `https://www.iadb.org${href}`
              : "https://www.iadb.org/en/projects/all",
            description: `IDB project: ${title}`,
            country: "Caribbean / Latin America",
            sector: "Development",
          });
        }

        if (results.length > 0) break;
      } catch (err) { lastError = err instanceof Error ? err : new Error(String(err)); }
    }

    // Every listing failed — surface it instead of pretending the source is empty.
    // No listing page could be loaded at all — report it rather than look "empty".
    if (okPages === 0 && lastError) throw lastError;
    return results;
  }
}
