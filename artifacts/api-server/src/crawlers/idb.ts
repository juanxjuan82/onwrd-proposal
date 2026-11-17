import { TenderSourceAdapter, TenderOpportunity, safeFetch, stripHtml } from "./base-adapter.js";

export class IDBAdapter implements TenderSourceAdapter {
  adapterType = "idb";

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    const results: TenderOpportunity[] = [];

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
        if (!r.ok) continue;
        const html = await r.text();
        if (html.length < 500) continue;

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
            externalId: `idb-${Buffer.from(title.slice(0, 40)).toString("base64").slice(0, 16)}`,
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
      } catch { /* try next */ }
    }

    return results;
  }
}
