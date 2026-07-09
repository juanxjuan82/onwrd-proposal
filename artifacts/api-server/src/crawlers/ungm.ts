import { TenderSourceAdapter, TenderOpportunity, safeFetch, stripHtml } from "./base-adapter.js";

export class UNGMAdapter implements TenderSourceAdapter {
  adapterType = "ungm";

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    const results: TenderOpportunity[] = [];
    try {
      const r = await safeFetch("https://www.ungm.org/Public/Notice", {
        headers: { Accept: "text/html" },
      });
      if (!r.ok) return results;

      const html = await r.text();
      const rowPattern = /<tr[^>]*class="[^"]*noticeRow[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
      let match;

      while ((match = rowPattern.exec(html)) !== null) {
        const row = match[1];
        const titleMatch = row.match(/class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
        const orgMatch = row.match(/class="[^"]*organization[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
        const deadlineMatch = row.match(/class="[^"]*deadline[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
        const linkMatch = row.match(/href="(\/Public\/Notice\/\d+[^"]*)"/i);

        const title = titleMatch ? stripHtml(titleMatch[1], 200) : "";
        if (!title || title.length < 5) continue;

        const org = orgMatch ? stripHtml(orgMatch[1], 100) : "UN Agency";
        const deadlineStr = deadlineMatch ? stripHtml(deadlineMatch[1], 50) : "";
        const deadline = deadlineStr ? new Date(deadlineStr) : undefined;
        const path = linkMatch ? linkMatch[1] : "";
        const noticeId = path.match(/\/(\d+)/)?.[1] ?? "";

        results.push({
          externalId: `ungm-${noticeId}`,
          title,
          organization: org,
          url: path ? `https://www.ungm.org${path}` : "https://www.ungm.org/Public/Notice",
          deadline: deadline && !isNaN(deadline.getTime()) ? deadline : undefined,
          description: `UN procurement notice from ${org}`,
          country: "International",
          sector: "UN Agency",
        });
      }
    } catch { /* return empty on failure */ }

    return results;
  }
}
