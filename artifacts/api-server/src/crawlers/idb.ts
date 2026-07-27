import { TenderSourceAdapter, TenderOpportunity, AdapterFetchResult, safeFetch, stripHtml } from "./base-adapter.js";

export class IDBAdapter implements TenderSourceAdapter {
  adapterType = "idb";

  async fetchOpportunities(): Promise<AdapterFetchResult> {
    const warnings: string[] = [];
    let requestsAttempted = 0;
    let requestsSucceeded = 0;
    const results: TenderOpportunity[] = [];
    const seen = new Set<string>();

    const urls = [
      "https://www.iadb.org/en/projects/all?query=communications+marketing&country=BS,JM,TT,BB,GY,LC,VC",
      "https://www.iadb.org/en/projects/all?query=media+tourism+campaign&country=BS,JM,TT,BB",
    ];

    for (const url of urls) {
      requestsAttempted++;
      try {
        const r = await safeFetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; TenderBot/1.0)", Accept: "text/html" },
        });
        if (!r.ok) {
          warnings.push(`IDB HTTP ${r.status} for ${url}`);
          continue;
        }
        const html = await r.text();
        if (html.length < 500) {
          warnings.push(`IDB returned very short response (${html.length} chars) for ${url}`);
          continue;
        }
        requestsSucceeded++;

        const articlePattern = /<article[^>]*>([\s\S]*?)<\/article>/gi;
        let match;
        let count = 0;

        while ((match = articlePattern.exec(html)) !== null && count < 15) {
          const block = match[1];
          const titleMatch = block.match(/<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/i);
          const linkMatch = block.match(/href="([^"]*\/en\/project[^"]+)"/i);
          const descMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
          const title = titleMatch ? stripHtml(titleMatch[1], 200) : "";
          if (!title || title.length < 10) continue;

          const titleKey = title.toLowerCase().slice(0, 60);
          if (seen.has(titleKey)) continue;
          seen.add(titleKey);

          const href = linkMatch ? linkMatch[1] : "";
          const rawDesc = descMatch ? stripHtml(descMatch[1], 600) : "";
          const description = rawDesc.length >= 80 ? rawDesc : `IDB project: ${title}`;
          count++;

          results.push({
            externalId: `idb-${Buffer.from(title.slice(0, 40)).toString("base64").slice(0, 16)}`,
            title,
            organization: "Inter-American Development Bank",
            url: href
              ? href.startsWith("http") ? href : `https://www.iadb.org${href}`
              : "https://www.iadb.org/en/projects/all",
            description,
            country: "Caribbean / Latin America",
            sector: "Development",
          });
        }

        if (results.length > 0) break;
      } catch (err) {
        warnings.push(`IDB fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (requestsAttempted > 0 && requestsSucceeded === 0) {
      throw new Error(`IDB: all ${requestsAttempted} requests failed. ` + warnings.join("; "));
    }

    return { opportunities: results, requestsAttempted, requestsSucceeded, warnings };
  }
}
