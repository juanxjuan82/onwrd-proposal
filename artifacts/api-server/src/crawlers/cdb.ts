import { TenderSourceAdapter, TenderOpportunity, safeFetch, stripHtml } from "./base-adapter.js";

export class CDBAdapter implements TenderSourceAdapter {
  adapterType = "cdb";

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    const results: TenderOpportunity[] = [];
    try {
      const r = await safeFetch("https://www.caribank.org/procurement", {
        headers: { Accept: "text/html" },
      });
      if (!r.ok) return results;

      const html = await r.text();
      const itemPattern = /<li[^>]*>([\s\S]*?)<\/li>/gi;
      let match;
      let count = 0;

      while ((match = itemPattern.exec(html)) !== null && count < 25) {
        const block = match[1];
        const linkMatch = block.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!linkMatch) continue;

        const title = stripHtml(linkMatch[2], 200);
        if (!title || title.length < 10) continue;

        const href = linkMatch[1];
        if (!href.includes("procur") && !href.includes("tender") && !href.includes("contract") && !href.includes("rfp")) continue;

        count++;
        results.push({
          externalId: `cdb-${Buffer.from(href).toString("base64").slice(0, 16)}`,
          title,
          organization: "Caribbean Development Bank",
          url: href.startsWith("http") ? href : `https://www.caribank.org${href}`,
          description: `Caribbean Development Bank procurement: ${title}`,
          country: "Caribbean",
          sector: "Development Finance",
        });
      }
    } catch { /* return empty on failure */ }

    return results;
  }
}
