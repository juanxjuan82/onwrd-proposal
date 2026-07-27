export interface TenderOpportunity {
  externalId?: string;
  title: string;
  organization: string;
  url?: string;
  deadline?: Date;
  description: string;
  country?: string;
  sector?: string;
  valueAmount?: string;
  rawData?: Record<string, unknown>;
}

/**
 * Structured result from an adapter's fetchOpportunities() call.
 *
 * - requestsAttempted: number of HTTP requests (or API calls) the adapter made
 * - requestsSucceeded: how many returned 2xx / parseable responses
 * - warnings: non-fatal issues (e.g. a single page 404 when others succeeded)
 *
 * An adapter MUST throw when ALL configured requests fail so the runner can
 * record a "failed" source run rather than a "success" with zero items.
 * A legitimate run with zero matching opportunities returns an empty
 * opportunities array with requestsSucceeded > 0.
 */
export interface AdapterFetchResult {
  opportunities: TenderOpportunity[];
  requestsAttempted: number;
  requestsSucceeded: number;
  warnings: string[];
}

export interface TenderSourceAdapter {
  adapterType: string;
  fetchOpportunities(): Promise<AdapterFetchResult>;
}

/** Injectable fetch function — defaults to safeFetch in production, injectable in tests. */
export type FetchFn = (url: string, opts?: RequestInit) => Promise<Response>;

export async function safeFetch(url: string, opts?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...opts,
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; ONWRD-TenderBot/1.0)",
      Accept: "application/json, text/html, */*",
      ...opts?.headers,
    },
    signal: AbortSignal.timeout(20000),
  });
}

export function stripHtml(html: string, maxLen = 800): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&#\d+;/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, maxLen);
}

/**
 * Fetch a detail page and return meaningful description text, or null if the
 * page is unavailable or yields < minLen characters of real content.
 *
 * Tries common content-block CSS selectors first, then falls back to the full
 * stripped body. Rejects obvious boilerplate (cookie walls, JS-only pages).
 */
export async function fetchDetailDescription(
  url: string,
  fetchFn: FetchFn,
  minLen = 120,
): Promise<string | null> {
  try {
    const r = await fetchFn(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ONWRD-TenderBot/1.0)",
        Accept: "text/html",
      },
    });
    if (!r.ok) return null;
    const html = await r.text();
    if (html.length < 200) return null;

    // Priority-ordered patterns to extract the main content block
    const patterns = [
      /<div[^>]*class="[^"]*(?:description|notice-body|content-area|scope|detail|tender-detail)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      /<section[^>]*class="[^"]*(?:description|detail|body|content|main)[^"]*"[^>]*>([\s\S]*?)<\/section>/i,
      /<article[^>]*>([\s\S]*?)<\/article>/i,
      /<div[^>]*class="[^"]*(?:entry-content|post-content|page-content|main-content)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      /<p[^>]*>([\s\S]{80,}?)<\/p>/i,
    ];

    for (const pat of patterns) {
      const m = html.match(pat);
      if (m) {
        const extracted = stripHtml(m[1], 1200).trim();
        if (
          extracted.length >= minLen &&
          !extracted.toLowerCase().startsWith("please enable") &&
          !extracted.toLowerCase().startsWith("this site uses cookies")
        ) {
          return extracted;
        }
      }
    }

    // Fallback: strip the whole body
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) {
      const bodyText = stripHtml(bodyMatch[1], 3000).trim();
      if (
        bodyText.length >= minLen &&
        !bodyText.toLowerCase().startsWith("please enable") &&
        !bodyText.toLowerCase().startsWith("enable javascript")
      ) {
        return bodyText.slice(0, 1200);
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Extract text from a PDF buffer using pdf-parse.
 *
 * Returns empty string when pdf-parse fails (encrypted, binary-only, or empty PDFs).
 * Callers must treat "" as no content and fall back to description = title so the
 * eligibility gate can correctly mark the item title_only.
 */
export async function extractPdfText(buf: Buffer, maxLen = 2000): Promise<string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParse = (await import("pdf-parse")).default;
    const data = await pdfParse(buf);
    return (data.text ?? "").replace(/\s{3,}/g, " ").trim().slice(0, maxLen);
  } catch {
    return "";
  }
}
