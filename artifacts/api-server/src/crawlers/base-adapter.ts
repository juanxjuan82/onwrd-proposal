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

export interface TenderSourceAdapter {
  adapterType: string;
  fetchOpportunities(): Promise<TenderOpportunity[]>;
}

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


/** Fetch an actual notice page, not an inferred marketing description. */
export async function fetchNoticeDetail(url: string): Promise<string | null> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    const response = await safeFetch(url, { headers: { Accept: "text/html" } });
    if (!response.ok || !(response.headers.get("content-type") ?? "").includes("text/html")) return null;
    const html = await response.text();
    const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1]
      ?? html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1]
      ?? html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1]
      ?? html;
    const content = stripHtml(main, 12000);
    return content.length >= 120 ? content : null;
  } catch {
    return null;
  }
}

/** Resolve relative links using URL semantics and reject external destinations. */
export function resolveNoticeUrl(href: string, origin: string): string | null {
  try {
    const url = new URL(href.replace(/&amp;/g, "&"), origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.hostname !== new URL(origin).hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}
