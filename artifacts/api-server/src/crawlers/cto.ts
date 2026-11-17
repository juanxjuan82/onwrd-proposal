import { TenderSourceAdapter, TenderOpportunity, safeFetch, stripHtml, stableId, absoluteUrl } from "./base-adapter.js";

// Caribbean Tourism Organization — monitors destination marketing, tourism promotion,
// branding and comms work across the Caribbean region.
export class CTOAdapter implements TenderSourceAdapter {
  adapterType = "cto";

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    const results: TenderOpportunity[] = [];
    let lastError: Error | undefined;
    let okPages = 0;

    const urls = [
      "https://www.caribtourism.com/procurement",
      "https://www.caribtourism.com/tenders",
      "https://www.caribtourism.com/news",
      "https://www.caribtourism.com/",
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

        const linkPattern =
          /<a[^>]+href="([^"]*(?:procur|tender|rfp|bid|contract|consult|market|campaign|brand|tourism)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
        let match;
        const seen = new Set<string>();

        while ((match = linkPattern.exec(html)) !== null) {
          const href = match[1];
          const rawTitle = stripHtml(match[2], 200).trim();
          if (!rawTitle || rawTitle.length < 8) continue;
          if (seen.has(rawTitle)) continue;
          seen.add(rawTitle);

          const fullUrl = absoluteUrl(href, url);
          // Test the link's PATH and text — not the domain. (The old pattern matched
          // "tourism" inside "caribtourism.com", so every link on the site qualified.)
          let pathAndText = rawTitle;
          try { pathAndText = `${new URL(fullUrl).pathname} ${rawTitle}`; } catch { /* keep title */ }
          if (!/procur|tender|rfp|\bbid|request for|expression of interest|consultan|terms of reference/i.test(pathAndText)) continue;
          if (seen.has(fullUrl)) continue;
          seen.add(fullUrl);


          results.push({
            externalId: stableId("cto", fullUrl),
            title: rawTitle,
            organization: "Caribbean Tourism Organization",
            url: fullUrl,
            // Real scope from page fetch only — no synthetic marketing assumption
            description: `Caribbean Tourism Organization procurement notice: ${rawTitle}`,
            country: "Caribbean",
            sector: "Tourism & Destination Marketing",
            rawData: {
              adapterContext:
                "CTO procurement: tourism destination marketing and communications for the Caribbean region.",
            },
          });

          if (results.length >= 20) break;
        }

        if (results.length > 0) break;
      } catch (err) { lastError = err instanceof Error ? err : new Error(String(err)); }
    }

    // No listing page could be loaded at all — report it rather than look "empty".
    if (okPages === 0 && lastError) throw lastError;
    return results;
  }
}
