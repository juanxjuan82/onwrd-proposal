import { createHash } from "node:crypto";
// Same import path the upload route uses (avoids pdf-parse's debug-mode wrapper).
import pdfParse from "pdf-parse/lib/pdf-parse.js";

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
  /**
   * Set to true when the adapter already supplies the full notice text (e.g.
   * from an API) or when the notice pages cannot be read by a crawler. The
   * runner then skips the "open the notice page" enrichment step.
   */
  skipDetailFetch?: boolean;
  fetchOpportunities(): Promise<TenderOpportunity[]>;
}

export const BOT_USER_AGENT = "Mozilla/5.0 (compatible; ONWRD-TenderBot/1.0)";

export async function safeFetch(url: string, opts?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...opts,
    headers: {
      "User-Agent": BOT_USER_AGENT,
      Accept: "application/json, text/html, */*",
      ...opts?.headers,
    },
    signal: AbortSignal.timeout(20000),
  });
}

/**
 * Fetch a listing page and return its HTML. Unlike a bare safeFetch this
 * THROWS when the site answers with an error, so a broken source shows up as
 * a failed run instead of silently returning nothing.
 */
export async function fetchListingHtml(url: string): Promise<string> {
  const r = await safeFetch(url, { headers: { Accept: "text/html" } });
  if (!r.ok) throw new Error(`${url} answered HTTP ${r.status}`);
  const html = await r.text();
  if (html.length < 500) throw new Error(`${url} returned an empty page`);
  return html;
}

/**
 * Stable, collision-safe ID for a discovery. Hashes the FULL input, so two
 * notices whose titles merely start the same way get different IDs.
 * (The previous approach kept only the first 12 characters of the title/URL,
 * which made unrelated notices look like duplicates.)
 */
export function stableId(prefix: string, ...parts: Array<string | undefined>): string {
  const input = parts.map((p) => (p ?? "").trim().toLowerCase()).join("|");
  return `${prefix}-${createHash("sha1").update(input).digest("hex").slice(0, 20)}`;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", nbsp: " ", quot: '"', apos: "'",
  ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  hellip: "…", laquo: "«", raquo: "»", eacute: "é", Eacute: "É",
  aacute: "á", iacute: "í", oacute: "ó", uacute: "ú", ntilde: "ñ",
  ccedil: "ç", atilde: "ã", otilde: "õ", agrave: "à", egrave: "è",
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name: string) => NAMED_ENTITIES[name] ?? " ");
}

function safeCodePoint(n: number): string {
  try {
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " ";
  } catch {
    return " ";
  }
}

export function stripHtml(html: string, maxLen = 800): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, maxLen);
}

export function absoluteUrl(href: string, base: string): string {
  try {
    return new URL(decodeEntities(href), base).toString();
  } catch {
    return href;
  }
}

// ── Dates ────────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function normYear(y: number): number {
  return y < 100 ? 2000 + y : y;
}

function buildDate(y: number, m: number, d: number): Date | undefined {
  if (m < 0 || m > 11 || d < 1 || d > 31) return undefined;
  const year = normYear(y);
  if (year < 2000 || year > 2100) return undefined;
  // End of the named day (UTC) so a tender closing "today" is not treated as expired.
  const date = new Date(Date.UTC(year, m, d, 23, 59, 59));
  return isNaN(date.getTime()) ? undefined : date;
}

const MONTH_RX = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*";
const DATE_PATTERNS: Array<{ rx: RegExp; build: (m: RegExpMatchArray) => Date | undefined }> = [
  // 2026-12-10 (ISO)
  { rx: /\b(20\d{2})-(\d{1,2})-(\d{1,2})(?!\d)/i, build: (m) => buildDate(+m[1], +m[2] - 1, +m[3]) },
  // 15-Dec-26, 15 Dec 2026, 15th December, 2026
  {
    rx: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s-]+(?:of\\s+)?${MONTH_RX}\\.?,?[\\s-]+(\\d{4}|\\d{2})\\b`, "i"),
    build: (m) => buildDate(+m[3], MONTHS[m[2].toLowerCase()], +m[1]),
  },
  // December 15, 2026 / Dec 18, 2026
  {
    rx: new RegExp(`\\b${MONTH_RX}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "i"),
    build: (m) => buildDate(+m[3], MONTHS[m[1].toLowerCase()], +m[2]),
  },
];

/** Parse the first recognisable date in a short piece of text. */
export function parseLooseDate(text: string | undefined | null): Date | undefined {
  if (!text) return undefined;
  let best: { index: number; date: Date } | undefined;
  for (const { rx, build } of DATE_PATTERNS) {
    const m = text.match(rx);
    if (!m || m.index === undefined) continue;
    const date = build(m);
    if (date && (!best || m.index < best.index)) best = { index: m.index, date };
  }
  return best?.date;
}

const DEADLINE_LABEL =
  /(closing date|submission deadline|deadline for (?:the )?(?:submission|receipt)[a-z ]*|deadline|closes on|closing on|due date|no later than|not later than|on or before|must be (?:received|submitted) by)/gi;

/** Find a deadline in free text by looking for a date shortly after a deadline-style label. */
export function extractDeadline(text: string): Date | undefined {
  DEADLINE_LABEL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DEADLINE_LABEL.exec(text)) !== null) {
    const window = text.slice(m.index + m[0].length, m.index + m[0].length + 90);
    const date = parseLooseDate(window);
    if (date) return date;
  }
  return undefined;
}

// ── Notice-page enrichment ───────────────────────────────────────────────────

const MAX_DESCRIPTION_CHARS = 4000;
const MAX_PDF_BYTES = 8 * 1024 * 1024;

/** Pull the main readable text out of a notice page, ignoring menus and footers. */
export function extractMainText(html: string, maxLen = MAX_DESCRIPTION_CHARS): string {
  const cleaned = html
    .replace(/<(script|style|noscript|svg|nav|header|footer|form|aside)\b[\s\S]*?<\/\1>/gi, " ");
  const candidates = [
    ...cleaned.matchAll(/<article\b[\s\S]*?<\/article>/gi),
    ...cleaned.matchAll(/<main\b[\s\S]*?<\/main>/gi),
  ].map((m) => stripHtml(m[0], maxLen * 3));
  // Choose the largest article/main block; fall back to the whole body.
  const best = candidates.sort((a, b) => b.length - a.length)[0];
  const text = best && best.length >= 200 ? best : stripHtml(cleaned, maxLen * 3);
  return text.slice(0, maxLen);
}

async function pdfToText(buf: Buffer): Promise<string> {
  const data = await pdfParse(buf, { max: 6 }); // first 6 pages is plenty for scope
  return data.text.replace(/\s{2,}/g, " ").trim();
}

async function fetchPdfText(url: string): Promise<string> {
  const r = await safeFetch(url, { headers: { Accept: "application/pdf,*/*" } });
  if (!r.ok) return "";
  const len = Number(r.headers.get("content-length") ?? 0);
  if (len > MAX_PDF_BYTES) return "";
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_PDF_BYTES) return "";
  // Only parse real PDFs (they always start with "%PDF").
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") return "";
  return pdfToText(buf);
}

export interface NoticeDetail {
  text: string;
  deadline?: Date;
}

/**
 * Open a notice's own page and return its real text (and deadline if stated).
 * Handles HTML pages and PDF documents. When an HTML page is just a thin
 * wrapper around an attached PDF, the PDF is read as well.
 */
export async function fetchNoticeDetail(url: string): Promise<NoticeDetail | null> {
  const r = await safeFetch(url, { headers: { Accept: "text/html,application/pdf,*/*" } });
  if (!r.ok) return null;
  const type = (r.headers.get("content-type") ?? "").toLowerCase();

  let text = "";
  if (type.includes("pdf") || /\.pdf(\?|$)/i.test(url)) {
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length <= MAX_PDF_BYTES) text = await pdfToText(buf);
  } else if (type.includes("html") || type === "") {
    const html = await r.text();
    text = extractMainText(html);
    if (text.length < 400) {
      // An attached document: a .pdf link, or a ".../download" link.
      const pdfHref = html.match(/href="([^"]+(?:\.pdf(?:\?[^"]*)?|\/download))"/i)?.[1];
      if (pdfHref) {
        try {
          const pdfText = await fetchPdfText(absoluteUrl(pdfHref, url));
          if (pdfText.length > 100) text = `${text} ${pdfText}`.trim();
        } catch { /* keep the HTML text */ }
      }
    }
  } else {
    return null;
  }

  text = text.slice(0, MAX_DESCRIPTION_CHARS);
  if (text.length < 40) return null;
  return { text, deadline: extractDeadline(text) };
}

/** True when the page text mentions enough of the title's distinctive words. */
export function textMatchesTitle(text: string, title: string): boolean {
  const words = [...new Set(title.toLowerCase().match(/[a-zà-ÿ]{5,}/g) ?? [])].slice(0, 8);
  if (words.length === 0) return true;
  const haystack = text.toLowerCase();
  const hits = words.filter((w) => haystack.includes(w)).length;
  return hits >= Math.min(2, words.length);
}

/**
 * Replace a headline-only description with the notice's real text.
 * Returns true when the opportunity was improved. Never throws.
 */
export async function enrichOpportunity(opp: TenderOpportunity): Promise<boolean> {
  if (!opp.url) return false;
  try {
    const detail = await fetchNoticeDetail(opp.url);
    if (!detail) return false;
    // Guard against links that land on a home page, login page or error page:
    // the page must actually talk about the thing named in the title.
    if (!textMatchesTitle(detail.text, opp.title)) return false;
    let improved = false;
    if (detail.text.length > opp.description.length + 40) {
      opp.description = detail.text;
      improved = true;
    }
    if (!opp.deadline && detail.deadline) {
      opp.deadline = detail.deadline;
      improved = true;
    }
    return improved;
  } catch {
    return false;
  }
}
