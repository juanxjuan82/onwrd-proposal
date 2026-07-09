import { TenderSourceAdapter, TenderOpportunity, safeFetch, stripHtml } from "./base-adapter.js";

export class IDBAdapter implements TenderSourceAdapter {
  adapterType = "idb";

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    const results: TenderOpportunity[] = [];
    try {
      const r = await safeFetch(
        "https://www.iadb.org/en/project-procurement?query=communications+marketing+caribbean",
        { headers: { Accept: "text/html" } }
      );
      if (!r.ok) return results;

      const html = await r.text();
      const itemPattern = /<article[^>]*>([\s\S]*?)<\/article>/gi;
      let match;
      let count = 0;

      while ((match = itemPattern.exec(html)) !== null && count < 20) {
        const block = match[1];
        const titleMatch = block.match(/<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/i);
        const linkMatch = block.match(/href="([^"]*procur[^"]*|[^"]*tender[^"]*|[^"]*contract[^"]*)"/i);
        const descMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);

        const title = titleMatch ? stripHtml(titleMatch[1], 200) : "";
        if (!title || title.length < 10) continue;

        count++;
        results.push({
          externalId: `idb-${Buffer.from(title).toString("base64").slice(0, 16)}`,
          title,
          organization: "Inter-American Development Bank",
          url: linkMatch
            ? (linkMatch[1].startsWith("http") ? linkMatch[1] : `https://www.iadb.org${linkMatch[1]}`)
            : "https://www.iadb.org/en/project-procurement",
          description: descMatch ? stripHtml(descMatch[1], 400) : `IDB procurement opportunity: ${title}`,
          country: "Caribbean / Latin America",
          sector: "Development",
        });
      }
    } catch { /* return empty on failure */ }

    return results;
  }
}
