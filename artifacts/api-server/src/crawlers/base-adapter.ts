import pdfParse from "pdf-parse/lib/pdf-parse.js";
import * as mammoth from "mammoth";

const nativeFetch = globalThis.fetch;
const lastRequestAt = new Map<string, number>();
const hostQueues = new Map<string, Promise<void>>();
const robotsCache = new Map<string, { rules: RobotsRule[]; expiresAt: number }>();
const HOST_REQUEST_INTERVAL_MS = 1_000;
const ROBOTS_CACHE_MS = 60 * 60 * 1_000;
const MAX_HTML_BYTES = 2_000_000;
const MAX_DOCUMENT_BYTES = 8_000_000;

let pdfParseQueue: Promise<unknown> = Promise.resolve();

interface RobotsRule {
  allow: boolean;
  path: string;
}

function parsePdfSerially(buffer: Buffer): Promise<{ text?: string }> {
  const result = pdfParseQueue.then(() => pdfParse(buffer));
  pdfParseQueue = result.then(() => undefined, () => undefined);
  return result as Promise<{ text?: string }>;
}

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

export type DocumentStatus =
  | "extracted"
  | "scanned_or_textless"
  | "fetch_failed"
  | "malformed"
  | "unsupported";

export interface TenderDocumentMetadata {
  url: string;
  format: "pdf" | "docx" | "unsupported";
  status: DocumentStatus;
  characters: number;
  extractedText?: string;
}

export type NoticeContentStatus =
  | "substantive"
  | "insufficient_scope"
  | "fetch_failed"
  | "unsupported_content";

export interface NoticeDetailResult {
  url: string;
  content: string;
  status: NoticeContentStatus;
  documents: TenderDocumentMetadata[];
}

export async function safeFetch(url: string, opts?: RequestInit): Promise<Response> {
  const parsed = new URL(url);
  await paceHost(parsed.hostname);
  return fetch(url, {
    ...opts,
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; ONWRD-TenderBot/1.0)",
      Accept: "application/json, text/html, */*",
      ...opts?.headers,
    },
    signal: opts?.signal ?? AbortSignal.timeout(20_000),
  });
}

/** Fail closed when robots.txt is unavailable or disallows the requested path. */
export async function assertRobotsAllows(
  url: string,
  userAgent = "ONWRD-TenderBot",
): Promise<void> {
  const target = new URL(url);
  const cacheKey = `${target.origin}|${userAgent.toLowerCase()}`;
  const shouldCache = globalThis.fetch === nativeFetch;
  const cached = shouldCache ? robotsCache.get(cacheKey) : undefined;
  let rules = cached && cached.expiresAt > Date.now() ? cached.rules : undefined;
  if (!rules) {
    const robotsUrl = new URL("/robots.txt", target.origin).toString();
    const { response, bytes } = await fetchApprovedBytes(robotsUrl, [target.hostname], 100_000);
    if (!response.ok) {
      throw new Error(`Cannot verify ${target.hostname} robots.txt (HTTP ${response.status}); refusing to crawl.`);
    }
    rules = parseRobotsRules(new TextDecoder().decode(bytes), userAgent);
    if (shouldCache) {
      robotsCache.set(cacheKey, { rules, expiresAt: Date.now() + ROBOTS_CACHE_MS });
    }
  }
  const path = `${target.pathname}${target.search}`;
  const strongest = rules
    .filter((rule) => robotsPatternMatches(rule.path, path))
    .sort((a, b) => robotsSpecificity(b.path) - robotsSpecificity(a.path)
      || Number(b.allow) - Number(a.allow))[0];
  if (strongest && !strongest.allow) {
    throw new Error(`robots.txt disallows ${path} on ${target.hostname}; refusing to crawl.`);
  }
}

function parseRobotsRules(text: string, userAgent: string): RobotsRule[] {
  const groups: Array<{ agents: string[]; rules: RobotsRule[]; hasRules: boolean }> = [];
  let current: { agents: string[]; rules: RobotsRule[]; hasRules: boolean } | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const agent = line.match(/^user-agent\s*:\s*(.+)$/i);
    if (agent) {
      if (!current || current.hasRules) {
        current = { agents: [], rules: [], hasRules: false };
        groups.push(current);
      }
      current.agents.push(agent[1].trim().toLowerCase());
      continue;
    }
    const directive = line.match(/^(allow|disallow)\s*:\s*(.*)$/i);
    if (directive && current) {
      current.hasRules = true;
      const path = directive[2].trim();
      if (path) current.rules.push({ allow: directive[1].toLowerCase() === "allow", path });
    }
  }
  const agent = userAgent.toLowerCase();
  const specificGroups = groups.filter((group) =>
    group.agents.some((name) => name !== "*" && agent.includes(name)));
  const applicable = specificGroups.length > 0
    ? specificGroups
    : groups.filter((group) => group.agents.includes("*"));
  return applicable.flatMap((group) => group.rules);
}

function robotsPatternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const raw = anchored ? pattern.slice(0, -1) : pattern;
  const expression = new RegExp(`^${raw.split("*").map(escapeRegExp).join(".*")}${anchored ? "$" : ""}`);
  return expression.test(path);
}

function robotsSpecificity(path: string): number {
  return path.replace(/[*$]/g, "").length;
}

async function paceHost(host: string): Promise<void> {
  // Tests replace global fetch with fixtures; keep them fast while pacing all
  // real direct requests to the same source host to one per second.
  if (globalThis.fetch !== nativeFetch) return;
  const previous = hostQueues.get(host) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => { release = resolve; });
  hostQueues.set(host, previous.then(() => current));
  await previous;
  const waitMs = Math.max(0, HOST_REQUEST_INTERVAL_MS - (Date.now() - (lastRequestAt.get(host) ?? 0)));
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  lastRequestAt.set(host, Date.now());
  release();
}

export function stripHtml(html: string, maxLen = 800): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|template|nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim(),
  ).slice(0, maxLen);
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_match, number: string) => String.fromCodePoint(Number(number)))
    .replace(/&#x([\da-f]+);/gi, (_match, number: string) => String.fromCodePoint(parseInt(number, 16)));
}

export function extractMainContent(html: string, maxLength = 12_000): string {
  const region = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1]
    ?? html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1]
    ?? html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1]
    ?? html;
  const withoutChrome = region
    .replace(/<(script|style|noscript|svg|template|nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/\sclass=(["'])[^"']*(?:breadcrumb|navigation|site-menu|sidebar|social|cookie|share|related)[^"']*\1[^>]*>[\s\S]*?<\/(?:div|ul|section)>/gi, " ");
  return stripHtml(withoutChrome, maxLength);
}

/** Extract text from a bounded listing row/card, never a page-wide text window. */
export function extractListingContext(
  html: string,
  linkPosition: number,
  maxLength = 1_500,
): string {
  if (linkPosition < 0 || linkPosition >= html.length) return "";
  const before = html.slice(0, linkPosition);
  const candidates: Array<{ start: number; tag: string }> = [];
  const opening = /<(article|li|tr|div)\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = opening.exec(before)) !== null) {
    const tag = match[1].toLowerCase();
    const openingTag = match[0];
    const usefulDiv = tag !== "div" || /\bclass\s*=\s*["'][^"']*(?:views-row|procurement|notice|tender|listing|card|item)[^"']*["']/i.test(openingTag);
    if (usefulDiv) candidates.push({ start: match.index, tag });
  }
  for (const candidate of candidates.reverse()) {
    const section = balancedElementAt(html, candidate.start, candidate.tag);
    if (section && section.start <= linkPosition && section.end > linkPosition) {
      return stripHtml(section.html, maxLength);
    }
  }
  return "";
}

function balancedElementAt(
  html: string,
  start: number,
  tag: string,
): { start: number; end: number; html: string } | null {
  const tokens = new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi");
  tokens.lastIndex = start;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(html)) !== null) {
    if (/^<\//.test(match[0])) depth--;
    else if (!/\/>$/.test(match[0])) depth++;
    if (depth === 0) return { start, end: tokens.lastIndex, html: html.slice(start, tokens.lastIndex) };
  }
  return null;
}

export function hasSubstantiveScope(content: string, title: string): boolean {
  const normalized = content.replace(/\s+/g, " ").trim();
  const withoutTitle = title.trim()
    ? normalized.replace(new RegExp(escapeRegExp(title.trim()), "ig"), " ").replace(/\s+/g, " ").trim()
    : normalized;
  const words = withoutTitle.match(/[A-Za-z0-9][A-Za-z0-9'-]*/g) ?? [];
  if (normalized.length < 120 || withoutTitle.length < 60 || words.length < 12) return false;
  if (/^(?:home|about us|contact us|procurement notices?|past notices?|current notices?|open notices?|closed notices?|search|menu|navigation)(?:\s+(?:home|about us|contact us|procurement notices?|past notices?|current notices?|open notices?|closed notices?|search|menu|navigation))*$/i.test(withoutTitle)) return false;
  return true;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9,
  october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

/** Parse only dates associated with a deadline/closing/submission label. */
export function extractDeadline(text: string): Date | undefined {
  const match = text.match(
    /(?:deadline|closing(?: date)?|submission deadline|submit(?:ted)? by|due date|proposals? (?:are )?due)\s*(?:is|:|-)?\s*((?:\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})|(?:[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})|(?:\d{4}[/-]\d{1,2}[/-]\d{1,2})|(?:\d{1,2}[/-]\d{1,2}[/-]\d{4}))/i,
  );
  if (!match) return undefined;
  const raw = match[1].replace(/,/g, "").trim();
  let year: number;
  let month: number;
  let day: number;
  const iso = raw.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  const dayMonth = raw.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
  const monthDay = raw.match(/^([A-Za-z]{3,9})\s+(\d{1,2})\s+(\d{4})$/);
  const numeric = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (iso) {
    year = Number(iso[1]); month = Number(iso[2]) - 1; day = Number(iso[3]);
  } else if (dayMonth) {
    day = Number(dayMonth[1]); month = MONTHS[dayMonth[2].toLowerCase()]; year = Number(dayMonth[3]);
  } else if (monthDay) {
    month = MONTHS[monthDay[1].toLowerCase()]; day = Number(monthDay[2]); year = Number(monthDay[3]);
  } else if (numeric) {
    // Procurement notices in this source family use day/month/year.
    day = Number(numeric[1]); month = Number(numeric[2]) - 1; year = Number(numeric[3]);
  } else return undefined;
  if (!Number.isInteger(month) || month < 0 || month > 11 || day < 1 || day > 31 || year < 1900) return undefined;
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return undefined;
  return date;
}

/** Resolve a notice link against an allowlist and reject unsafe protocols/hosts. */
export function resolveNoticeUrl(
  href: string,
  origin: string,
  approvedHosts: readonly string[] = [new URL(origin).hostname],
): string | null {
  try {
    const url = new URL(href.replace(/&amp;/g, "&"), origin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = url.hostname.toLowerCase();
    if (!approvedHosts.some((approved) => host === approved.toLowerCase() || host.endsWith(`.${approved.toLowerCase()}`))) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export async function fetchApprovedBytes(
  url: string,
  approvedHosts: readonly string[],
  maxBytes = MAX_DOCUMENT_BYTES,
): Promise<{ response: Response; bytes: Buffer }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  let currentUrl = url;
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (!resolveNoticeUrl(currentUrl, currentUrl, approvedHosts)) {
        throw new Error("Request URL is outside the approved source hosts.");
      }
      const response = await safeFetch(currentUrl, {
        redirect: "manual",
        signal: controller.signal,
        headers: { Accept: "application/pdf, application/vnd.openxmlformats-officedocument.wordprocessingml.document, text/html, */*" },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("Redirect response did not include a destination.");
        const nextUrl = resolveNoticeUrl(location, currentUrl, approvedHosts);
        if (!nextUrl) throw new Error("Redirect destination is outside the approved source hosts.");
        currentUrl = nextUrl;
        continue;
      }
      if (!response.ok) return { response, bytes: Buffer.alloc(0) };
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > maxBytes) throw new Error(`Response exceeds the ${maxBytes}-byte limit.`);
      if (!response.body) {
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > maxBytes) throw new Error(`Response exceeds the ${maxBytes}-byte limit.`);
        return { response, bytes };
      }
      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel();
            throw new Error(`Response exceeds the ${maxBytes}-byte limit.`);
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
      return { response, bytes: Buffer.concat(chunks, total) };
    }
    throw new Error("Response exceeded the redirect limit.");
  } finally {
    clearTimeout(timeout);
  }
}

export async function extractProcurementDocuments(
  html: string,
  noticeUrl: string,
  approvedHosts: readonly string[],
  fetchBytes: typeof fetchApprovedBytes = fetchApprovedBytes,
  parsePdfText: (buffer: Buffer) => Promise<string> = async (buffer) =>
    (await parsePdfSerially(buffer)).text ?? "",
): Promise<TenderDocumentMetadata[]> {
  const region = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1]
    ?? html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1]
    ?? html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1]
    ?? html;
  const links: Array<{ url: string; format: TenderDocumentMetadata["format"] }> = [];
  const anchors = /<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchors.exec(region)) && links.length < 5) {
    const href = match[2];
    const label = stripHtml(match[3], 300);
    if (!/(procurement|tender|rfp|tor|terms|reference|proposal|eoi|expression|consult|scope|notice)/i.test(`${href} ${label}`)) continue;
    if (/\b(?:blank|template|application form)\b/i.test(`${href} ${label}`)) continue;
    const url = resolveNoticeUrl(href, noticeUrl, approvedHosts);
    if (!url || links.some((link) => link.url === url)) continue;
    const extension = new URL(url).pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
    if (!extension) continue;
    const format = extension === "pdf" ? "pdf" : extension === "docx" ? "docx" : "unsupported";
    links.push({ url, format });
  }

  const results: TenderDocumentMetadata[] = [];
  for (const link of links) {
    if (link.format === "unsupported") {
      results.push({ url: link.url, format: link.format, status: "unsupported", characters: 0 });
      continue;
    }
    let response: Response;
    let bytes: Buffer;
    try {
      ({ response, bytes } = await fetchBytes(link.url, approvedHosts, MAX_DOCUMENT_BYTES));
    } catch {
      results.push({ url: link.url, format: link.format, status: "fetch_failed", characters: 0 });
      continue;
    }
    if (!response.ok) {
      results.push({ url: link.url, format: link.format, status: "fetch_failed", characters: 0 });
      continue;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType && !/(pdf|wordprocessingml|octet-stream)/i.test(contentType)) {
      results.push({ url: link.url, format: link.format, status: "unsupported", characters: 0 });
      continue;
    }
    try {
      let text = link.format === "pdf"
        ? await parsePdfText(bytes)
        : (await mammoth.extractRawText({ buffer: bytes })).value ?? "";
      text = text.replace(/\s+/g, " ").trim().slice(0, 12_000);
      const substantiveCount = (text.match(/[A-Za-z0-9]/g) ?? []).length;
      results.push({
        url: link.url,
        format: link.format,
        status: substantiveCount >= 80 ? "extracted" : "scanned_or_textless",
        characters: text.length,
        ...(substantiveCount >= 80 ? { extractedText: text.slice(0, 4_000) } : {}),
      });
    } catch {
      results.push({ url: link.url, format: link.format, status: "malformed", characters: 0 });
    }
  }
  return results;
}

export async function fetchNoticeDetailResult(
  url: string,
  title: string,
  approvedHosts: readonly string[] = [new URL(url).hostname],
): Promise<NoticeDetailResult> {
  try {
    const { response, bytes } = await fetchApprovedBytes(url, approvedHosts, MAX_HTML_BYTES);
    if (!response.ok) {
      return { url, content: "", status: "fetch_failed", documents: [] };
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (/application\/pdf/i.test(contentType)) {
      const document = await extractPdfDocument(url, bytes);
      const content = document.extractedText ?? "";
      return {
        url,
        content,
        status: hasSubstantiveScope(content, title) ? "substantive" : "insufficient_scope",
        documents: [document],
      };
    }
    if (contentType && !/(html|xhtml|text\/plain)/i.test(contentType)) {
      return { url, content: "", status: "unsupported_content", documents: [] };
    }
    const html = new TextDecoder().decode(bytes);
    const pageContent = extractMainContent(html);
    const documents = await extractProcurementDocuments(html, url, approvedHosts);
    const attachedText = documents
      .filter((document) => document.status === "extracted" && document.extractedText)
      .map((document) => `[Document: ${document.url}] ${document.extractedText}`)
      .join("\n");
    const combined = `${pageContent}${attachedText ? `\n${attachedText}` : ""}`.slice(0, 4_000);
    return {
      url,
      content: combined,
      status: hasSubstantiveScope(combined, title) ? "substantive" : "insufficient_scope",
      documents,
    };
  } catch {
    return { url, content: "", status: "fetch_failed", documents: [] };
  }
}

async function extractPdfDocument(url: string, bytes: Buffer): Promise<TenderDocumentMetadata> {
  try {
    const text = ((await parsePdfSerially(bytes)).text ?? "").replace(/\s+/g, " ").trim().slice(0, 12_000);
    const substantiveCount = (text.match(/[A-Za-z0-9]/g) ?? []).length;
    return {
      url,
      format: "pdf",
      status: substantiveCount >= 80 ? "extracted" : "scanned_or_textless",
      characters: text.length,
      ...(substantiveCount >= 80 ? { extractedText: text.slice(0, 4_000) } : {}),
    };
  } catch {
    return { url, format: "pdf", status: "malformed", characters: 0 };
  }
}

/** Backwards-compatible helper used by existing callers and unit tests. */
export async function fetchNoticeDetail(url: string): Promise<string | null> {
  const result = await fetchNoticeDetailResult(url, "");
  return result.status === "substantive" ? result.content : null;
}
