import { TenderSourceAdapter, TenderOpportunity, AdapterFetchResult, safeFetch, stripHtml } from "./base-adapter.js";

// UNDP Procurement Notices — server-rendered HTML listing page.
// We fetch the listing, then fetch each notice's detail page to get real scope content.
export class UNGMAdapter implements TenderSourceAdapter {
  adapterType = "ungm";

  async fetchOpportunities(): Promise<AdapterFetchResult> {
    const warnings: string[] = [];
    let requestsAttempted = 0;
    let requestsSucceeded = 0;
    const results: TenderOpportunity[] = [];

    // ── Step 1: fetch the listing page ─────────────────────────────────────
    requestsAttempted++;
    let listingHtml: string;
    try {
      const r = await safeFetch("https://procurement-notices.undp.org/", {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; TenderBot/1.0)", Accept: "text/html" },
      });
      if (!r.ok) {
        throw new Error(`UNDP listing HTTP ${r.status}`);
      }
      listingHtml = await r.text();
      requestsSucceeded++;
    } catch (err) {
      throw new Error(`UNDP listing fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ── Step 2: extract notice IDs and titles from listing ─────────────────
    const linkPattern = /<a[^>]+href="(view_notice\.cfm\?notice_id=(\d+))"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    const seen = new Set<string>();
    const candidates: Array<{ path: string; noticeId: string; rawTitle: string }> = [];

    while ((match = linkPattern.exec(listingHtml)) !== null) {
      const path = match[1];
      const noticeId = match[2];
      const rawTitle = stripHtml(match[3], 250).replace(/^Title\s+/i, "").trim();

      if (!noticeId || !rawTitle || rawTitle.length < 8) continue;
      if (seen.has(noticeId)) continue;
      seen.add(noticeId);
      candidates.push({ path, noticeId, rawTitle });
      if (candidates.length >= 30) break;
    }

    if (candidates.length === 0) {
      warnings.push("UNDP listing returned no notice links");
      return { opportunities: results, requestsAttempted, requestsSucceeded, warnings };
    }

    // ── Step 3: fetch detail pages with bounded concurrency (4 at a time) ──
    const CONCURRENCY = 4;
    for (let i = 0; i < candidates.length; i += CONCURRENCY) {
      const batch = candidates.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async ({ path, noticeId, rawTitle }) => {
        const detailUrl = `https://procurement-notices.undp.org/${path}`;
        requestsAttempted++;

        let description = `UNDP procurement notice: ${rawTitle}`;
        try {
          const dr = await safeFetch(detailUrl, {
            headers: { "User-Agent": "Mozilla/5.0 (compatible; TenderBot/1.0)", Accept: "text/html" },
          });
          if (dr.ok) {
            requestsSucceeded++;
            const detailHtml = await dr.text();

            // Extract the main description block — UNDP uses a <div class="notice-description"> or similar
            const descPatterns = [
              /<div[^>]*class="[^"]*(?:description|notice-body|content-area|scope)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
              /<section[^>]*class="[^"]*(?:description|detail|body)[^"]*"[^>]*>([\s\S]*?)<\/section>/i,
              // Fallback: find a large text block
              /<p[^>]*>([\s\S]{100,}?)<\/p>/i,
            ];

            for (const pat of descPatterns) {
              const dm = detailHtml.match(pat);
              if (dm) {
                const extracted = stripHtml(dm[1], 1200).trim();
                if (extracted.length >= 100 && !extracted.toLowerCase().includes("cookie")) {
                  description = extracted;
                  break;
                }
              }
            }
          } else {
            warnings.push(`UNDP detail HTTP ${dr.status} for notice ${noticeId}`);
          }
        } catch (err) {
          warnings.push(`UNDP detail fetch failed for notice ${noticeId}: ${err instanceof Error ? err.message : String(err)}`);
        }

        const titleLower = rawTitle.toLowerCase();
        const country =
          titleLower.includes("bahamas")   ? "Bahamas" :
          titleLower.includes("caribbean") ? "Caribbean" :
          titleLower.includes("jamaica")   ? "Jamaica" :
          titleLower.includes("barbados")  ? "Barbados" :
          titleLower.includes("trinidad")  ? "Trinidad and Tobago" :
          titleLower.includes("guyana")    ? "Guyana" :
          titleLower.includes("belize")    ? "Belize" :
          "International";

        results.push({
          externalId: `undp-${noticeId}`,
          title: rawTitle,
          organization: "UNDP",
          url: detailUrl,
          description,
          country,
          sector: "United Nations",
        });
      }));
    }

    // Listing succeeded even if some detail pages failed
    return { opportunities: results, requestsAttempted, requestsSucceeded, warnings };
  }
}
