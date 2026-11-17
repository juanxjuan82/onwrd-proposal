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
