import type {
  Crawl4AIClient,
  Crawl4AIError,
  RenderedPageResult,
} from "./crawl4ai-client.js";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import * as mammoth from "mammoth";

let pdfParseQueue: Promise<unknown> = Promise.resolve();

function parsePdfSerially(buffer: Buffer) {
  const result = pdfParseQueue.then(() => pdfParse(buffer));
  pdfParseQueue = result.then(() => undefined, () => undefined);
  return result;
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

export type CrawlDiagnosticCode =
  | "direct_success"
  | "direct_failed"
  | "direct_unusable"
  | "crawl4ai_success"
  | "crawl4ai_timeout"
  | "crawl4ai_authentication"
  | "crawl4ai_off_domain_redirect"
  | "crawl4ai_unusable_content"
  | "crawl4ai_service_unavailable"
  | "crawl4ai_malformed_response"
  | "crawl4ai_blocked"
  | "crawl4ai_invalid_config"
  | "crawl4ai_version_mismatch"
  | "crawl4ai_response_too_large";

export interface CrawlDiagnostic {
  code: CrawlDiagnosticCode;
  url: string;
  message: string;
  method: "direct" | "crawl4ai";
}

export interface AdapterFetchContext {
  crawl4ai?: Crawl4AIClient;
  approvedDomains?: readonly string[];
  diagnostics?: CrawlDiagnostic[];
}

export interface TenderSourceAdapter {
  adapterType: string;
  fetchOpportunities(context?: AdapterFetchContext): Promise<TenderOpportunity[]>;
}

export async function safeFetch(url: string, opts?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...opts,
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; ONWRD-TenderBot/1.0)",
      Accept: "application/json, text/html, */*",
      ...opts?.headers,
    },
    signal: opts?.signal ?? AbortSignal.timeout(20000),
  });
}

/** Resolve a notice link relative to its listing page, constrained to approved hosts. */
export function resolveNoticeUrl(
  href: string,
  origin: string,
  approvedDomains?: readonly string[],
): string | null {
  try {
    const base = new URL(origin);
    const resolved = new URL(href.replace(/&amp;/g, "&"), base);
    if (resolved.protocol !== "https:" && resolved.protocol !== "http:") return null;
    if (!isApprovedUrl(resolved.toString(), approvedDomains ?? [base.hostname])) return null;
    return resolved.toString();
  } catch {
    return null;
  }
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

export function extractDeadline(text: string): Date | undefined {
  const match = text.match(
    /(?:deadline|closing date|submission date|submit(?:ted)? by|due date)[^.\n:]*[:\s]+([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}[/-]\d{1,2}[/-]\d{1,2})/i,
  );
  if (!match) return undefined;
  const date = new Date(match[1]);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export interface HtmlPageResult {
  html: string;
  method: "direct" | "crawl4ai";
  rendered?: RenderedPageResult;
}

export interface TenderDetailResult {
  content: string;
  metadata: RenderedPageResult["metadata"];
  method: "direct" | "crawl4ai";
  documents?: TenderDocumentMetadata[];
}

export interface TenderDocumentMetadata {
  url: string;
  format: "pdf" | "docx";
  status: "extracted" | "scanned_or_textless" | "fetch_failed" | "malformed";
  characters: number;
  extractedText?: string;
}

export function prioritizeDocumentContent(
  pageContent: string,
  documents: readonly TenderDocumentMetadata[],
  maxLength = 4_000,
): string {
  const documentText = documents
    .filter((document) => document.status === "extracted" && document.extractedText)
    .map((document) => `[Document: ${document.url}]\n${document.extractedText}`)
    .join("\n\n")
    .slice(0, Math.min(2_400, Math.max(0, maxLength - 1_000)));
  const pageBudget = Math.max(0, maxLength - documentText.length - (documentText ? 2 : 0));
  return `${pageContent.slice(0, pageBudget)}${documentText ? `\n\n${documentText}` : ""}`.slice(0, maxLength);
}

export function mergeDocumentEvidence(
  existingRaw: Record<string, unknown>,
  incomingRaw: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const existingDocs = Array.isArray(existingRaw.documentExtraction)
    ? existingRaw.documentExtraction.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : [];
  const incomingDocs = Array.isArray(incomingRaw?.documentExtraction)
    ? incomingRaw.documentExtraction.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : [];
  const hasNewText = incomingDocs.some((incoming) =>
    incoming.status === "extracted" &&
    typeof incoming.extractedText === "string" &&
    incoming.extractedText.length > 0 &&
    !existingDocs.some((existing) =>
      existing.url === incoming.url && existing.extractedText === incoming.extractedText));
  if (!hasNewText) return undefined;

  const byUrl = new Map<string, Record<string, unknown>>();
  for (const document of existingDocs) {
    if (typeof document.url === "string") byUrl.set(document.url, document);
  }
  for (const document of incomingDocs) {
    if (typeof document.url !== "string") continue;
    const previous = byUrl.get(document.url);
    const previousText = previous?.extractedText;
    byUrl.set(
      document.url,
      typeof previousText === "string" && typeof document.extractedText !== "string"
        ? { ...document, ...previous }
        : { ...previous, ...document },
    );
  }
  return { ...existingRaw, documentExtraction: [...byUrl.values()] };
}

/**
 * Direct fetch is always attempted first. Crawl4AI is only a fallback for a
 * failed/thin page and never changes the normalized tender contract.
 */
export async function fetchHtmlWithOptionalBrowser(
  url: string,
  context: AdapterFetchContext | undefined,
  minDirectLength: number,
): Promise<HtmlPageResult> {
  let directHtml = "";
  let directError: unknown;
  try {
    const direct = await fetchApprovedText(
      url,
      context?.approvedDomains ?? [new URL(url).hostname],
      2_000_000,
      { headers: { Accept: "text/html" } },
    );
    const response = direct.response;
    if (!response.ok) {
      directError = new Error(`HTTP ${response.status}`);
      recordDiagnostic(context, {
        code: "direct_failed",
        url,
        message: `Direct fetch returned HTTP ${response.status}.`,
        method: "direct",
      });
    } else {
      directHtml = direct.text;
      if (directHtml.length >= minDirectLength) {
        recordDiagnostic(context, {
          code: "direct_success",
          url,
          message: `Direct fetch returned ${directHtml.length} bytes.`,
          method: "direct",
        });
        return { html: directHtml, method: "direct" };
      }
      recordDiagnostic(context, {
        code: "direct_unusable",
        url,
        message: `Direct fetch returned only ${directHtml.length} bytes.`,
        method: "direct",
      });
    }
  } catch (error) {
    directError = error;
    recordDiagnostic(context, {
      code: "direct_failed",
      url,
      message: error instanceof Error ? error.message : String(error),
      method: "direct",
    });
  }

  if (context?.crawl4ai) {
    try {
      const rendered = await context.crawl4ai.render(
        url,
        context.approvedDomains ?? [new URL(url).hostname],
      );
      recordDiagnostic(context, {
        code: "crawl4ai_success",
        url,
        message: `Rendered ${rendered.content.length} content characters and ${rendered.links.length} links.`,
        method: "crawl4ai",
      });
      return {
        html: rendered.html ?? rendered.content,
        method: "crawl4ai",
        rendered,
      };
    } catch (error) {
      recordCrawl4AIFailure(context, url, error);
    }
  }

  if (directHtml) {
    // A thin but valid page may still contain usable links. Return it rather
    // than silently dropping the source; adapters still require genuine
    // surrounding/detail content before creating an opportunity.
    return { html: directHtml, method: "direct" };
  }
  throw directError instanceof Error
    ? directError
    : new Error(`No usable HTML response for ${url}.`);
}

export async function enrichWithRenderedDetail(
  url: string,
  context: AdapterFetchContext | undefined,
): Promise<RenderedPageResult | undefined> {
  if (!context?.crawl4ai) return undefined;
  try {
    const rendered = await context.crawl4ai.render(
      url,
      context.approvedDomains ?? [new URL(url).hostname],
    );
    recordDiagnostic(context, {
      code: "crawl4ai_success",
      url,
      message: `Detail page rendered with ${rendered.content.length} content characters.`,
      method: "crawl4ai",
    });
    return rendered;
  } catch (error) {
    recordCrawl4AIFailure(context, url, error);
    return undefined;
  }
}

/**
 * Fetch detail content directly first. Browser rendering is attempted only
 * when the direct response fails or lacks detail-specific genuine scope.
 */
export async function fetchTenderDetailWithOptionalBrowser(
  url: string,
  title: string,
  context: AdapterFetchContext | undefined,
): Promise<TenderDetailResult | undefined> {
  try {
    const direct = await fetchApprovedText(
      url,
      context?.approvedDomains ?? [new URL(url).hostname],
      1_000_000,
      { headers: { Accept: "text/html, application/xhtml+xml" } },
    );
    const response = direct.response;
    if (response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType || /html|text/i.test(contentType)) {
        const html = direct.text;
        const content = extractMainContent(html);
        const documents = await extractProcurementDocuments(
          html,
          url,
          context?.approvedDomains ?? [new URL(url).hostname],
        );
        const documentText = documents
          .filter((document) => document.status === "extracted" && document.text)
          .map((document) => document.text)
          .join("");
        const documentMetadata: TenderDocumentMetadata[] = documents.map(
          ({ url: documentUrl, format, status, characters, text }) => ({
            url: documentUrl,
            format,
            status,
            characters,
            ...(text ? { extractedText: text.slice(0, 4_000) } : {}),
          }),
        );
        const combinedContent = prioritizeDocumentContent(content, documentMetadata);
        if (hasGenuineDetailContent(combinedContent, title)) {
          recordDiagnostic(context, {
            code: "direct_success",
            url,
            message: `Direct detail and document fetch returned ${combinedContent.length} genuine content characters.`,
            method: "direct",
          });
          return {
            content: combinedContent.slice(0, 4_000),
            metadata: {},
            method: "direct",
            documents: documentMetadata,
          };
        }
        if (documentMetadata.length) {
          recordDiagnostic(context, {
            code: "direct_unusable",
            url,
            message: `Document extraction completed with statuses: ${documentMetadata.map((d) => d.status).join(", ")}.`,
            method: "direct",
          });
        }
      }
      recordDiagnostic(context, {
        code: "direct_unusable",
        url,
        message: "Direct detail response did not contain enough genuine scope content.",
        method: "direct",
      });
    } else {
      recordDiagnostic(context, {
        code: "direct_failed",
        url,
        message: `Direct detail fetch returned HTTP ${response.status}.`,
        method: "direct",
      });
    }
  } catch (error) {
    recordDiagnostic(context, {
      code: "direct_failed",
      url,
      message: error instanceof Error ? error.message : String(error),
      method: "direct",
    });
  }

  const rendered = await enrichWithRenderedDetail(url, context);
  if (!rendered) return undefined;
  if (!hasGenuineDetailContent(rendered.content, title)) {
    recordDiagnostic(context, {
      code: "crawl4ai_unusable_content",
      url,
      message: "Rendered detail did not contain enough detail-specific scope content.",
      method: "crawl4ai",
    });
    return undefined;
  }
  return {
    content: rendered.content.slice(0, 4_000),
    metadata: rendered.metadata,
    method: "crawl4ai",
  };
}

function extractMainContent(html: string): string {
  const region = html.match(/<article\b[\s\S]*?<\/article>/i)?.[0]
    ?? html.match(/<main\b[\s\S]*?<\/main>/i)?.[0]
    ?? html;
  return stripHtml(region, 12_000);
}

type TenderDocumentStatus = "extracted" | "scanned_or_textless" | "fetch_failed" | "malformed";
type TenderDocument = TenderDocumentMetadata & {
  text?: string;
};

export async function extractProcurementDocuments(
  html: string,
  pageUrl: string,
  approvedDomains: readonly string[],
  fetchBytes: typeof fetchApprovedBytes = fetchApprovedBytes,
  parsePdfText: (buffer: Buffer) => Promise<string> = async (buffer) =>
    (await parsePdfSerially(buffer)).text ?? "",
): Promise<TenderDocument[]> {
  const region = html.match(/<article\b[\s\S]*?<\/article>/i)?.[0]
    ?? html.match(/<main\b[\s\S]*?<\/main>/i)?.[0]
    ?? html;
  const links: Array<{ href: string; label: string }> = [];
  const anchorPattern = /<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(region)) && links.length < 3) {
    const href = match[2].replace(/&amp;/g, "&");
    const label = stripHtml(match[3], 300);
    if (!/\.(?:pdf|docx)(?:[?#]|$)/i.test(href)) continue;
    if (/\b(?:blank|template|application form)\b/i.test(`${href} ${label}`)) continue;
    if (!/(procurement|tender|rfp|tor|terms|reference|proposal|eoi|expression|consult|scope|notice)/i.test(`${href} ${label}`)) continue;
    const safeUrl = resolveNoticeUrl(href, pageUrl, approvedDomains);
    if (safeUrl && !links.some((link) => link.href === safeUrl)) links.push({ href: safeUrl, label });
  }

  const results: TenderDocument[] = [];
  for (const link of links) {
    const format = /\.docx(?:[?#]|$)/i.test(link.href) ? "docx" : "pdf";
    let response: Response;
    let bytes: Buffer;
    try {
      ({ response, bytes } = await fetchBytes(link.href, approvedDomains, 8_000_000));
    } catch {
      results.push({ url: link.href, format, status: "fetch_failed", characters: 0 });
      continue;
    }
    if (!response.ok) {
      results.push({ url: link.href, format, status: "fetch_failed", characters: 0 });
      continue;
    }
    try {
      let text = "";
      if (format === "pdf") {
        text = await parsePdfText(bytes);
      } else {
        const parsed = await mammoth.extractRawText({ buffer: bytes });
        text = parsed.value ?? "";
      }
      text = text.replace(/\s+/g, " ").trim().slice(0, 12_000);
      const substantiveCharacters = (text.match(/[A-Za-z0-9]/g) ?? []).length;
      results.push({
        url: link.href,
        format,
        status: substantiveCharacters >= 80 ? "extracted" : "scanned_or_textless",
        characters: text.length,
        ...(substantiveCharacters >= 80 ? { text } : {}),
      });
    } catch {
      results.push({ url: link.href, format, status: "malformed", characters: 0 });
    }
  }
  return results;
}

function recordCrawl4AIFailure(
  context: AdapterFetchContext,
  url: string,
  error: unknown,
): void {
  const crawlError = error as Partial<Crawl4AIError>;
  const codeMap: Record<string, CrawlDiagnosticCode> = {
    timeout: "crawl4ai_timeout",
    authentication: "crawl4ai_authentication",
    off_domain_redirect: "crawl4ai_off_domain_redirect",
    unusable_content: "crawl4ai_unusable_content",
    service_unavailable: "crawl4ai_service_unavailable",
    malformed_response: "crawl4ai_malformed_response",
    blocked: "crawl4ai_blocked",
    invalid_config: "crawl4ai_invalid_config",
    version_mismatch: "crawl4ai_version_mismatch",
    response_too_large: "crawl4ai_response_too_large",
  };
  const errorCode = typeof crawlError.code === "string" ? crawlError.code : "service_unavailable";
  recordDiagnostic(context, {
    code: codeMap[errorCode] ?? "crawl4ai_service_unavailable",
    url,
    message: error instanceof Error ? error.message : String(error),
    method: "crawl4ai",
  });
}

function recordDiagnostic(context: AdapterFetchContext | undefined, diagnostic: CrawlDiagnostic): void {
  context?.diagnostics?.push(diagnostic);
}

export function hasGenuineDetailContent(content: string, title: string): boolean {
  const safeTitle = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withoutTitle = content.replace(new RegExp(safeTitle, "gi"), "").trim();
  return content.length >= 120 && withoutTitle.length >= 60;
}

function isApprovedUrl(value: string, approvedDomains: readonly string[]): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return approvedDomains.some((domain) => {
      const normalized = domain.toLowerCase().replace(/^\.+/, "");
      return hostname === normalized || hostname.endsWith(`.${normalized}`);
    });
  } catch {
    return false;
  }
}

export async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > maxBytes) throw new Error(`Response exceeds ${maxBytes} bytes.`);
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error(`Response exceeds ${maxBytes} bytes.`);
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Response exceeds ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

export async function fetchApprovedText(
  url: string,
  approvedDomains: readonly string[],
  maxBytes: number,
  opts?: RequestInit,
): Promise<{ response: Response; text: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  let currentUrl = url;
  try {
    for (let redirectCount = 0; redirectCount <= 3; redirectCount++) {
      if (!isApprovedUrl(currentUrl, approvedDomains)) {
        throw new Error(`URL is outside approved domains: ${currentUrl}`);
      }
      const response = await safeFetch(currentUrl, {
        ...opts,
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status < 300 || response.status >= 400) {
        const text = await readBoundedResponseText(response, maxBytes);
        return { response, text };
      }
      const location = response.headers.get("location");
      if (!location) throw new Error(`Redirect from ${currentUrl} did not include a location.`);
      const nextUrl = new URL(location, currentUrl).toString();
      if (!isApprovedUrl(nextUrl, approvedDomains)) {
        throw new Error(`Redirect target is outside approved domains: ${nextUrl}`);
      }
      currentUrl = nextUrl;
    }
    throw new Error(`Too many redirects fetching ${url}.`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchApprovedBytes(
  url: string,
  approvedDomains: readonly string[],
  maxBytes: number,
): Promise<{ response: Response; bytes: Buffer }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  let currentUrl = url;
  try {
    for (let redirectCount = 0; redirectCount <= 3; redirectCount++) {
      if (!isApprovedUrl(currentUrl, approvedDomains)) {
        throw new Error(`URL is outside approved domains: ${currentUrl}`);
      }
      const response = await safeFetch(currentUrl, { redirect: "manual", signal: controller.signal });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error(`Redirect from ${currentUrl} did not include a location.`);
        const nextUrl = new URL(location, currentUrl).toString();
        if (!isApprovedUrl(nextUrl, approvedDomains)) {
          throw new Error(`Redirect target is outside approved domains: ${nextUrl}`);
        }
        currentUrl = nextUrl;
        continue;
      }
      const declaredLength = Number(response.headers.get("content-length") ?? 0);
      if (declaredLength > maxBytes) throw new Error(`Document exceeds ${maxBytes} bytes.`);
      if (!response.body) {
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > maxBytes) throw new Error(`Document exceeds ${maxBytes} bytes.`);
        return { response, bytes };
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel();
            throw new Error(`Document exceeds ${maxBytes} bytes.`);
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      return { response, bytes: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))) };
    }
    throw new Error(`Too many redirects fetching ${url}.`);
  } finally {
    clearTimeout(timeout);
  }
}
