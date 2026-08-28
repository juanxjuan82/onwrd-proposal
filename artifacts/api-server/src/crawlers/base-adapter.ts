import type {
  Crawl4AIClient,
  Crawl4AIError,
  RenderedPageResult,
} from "./crawl4ai-client.js";

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
        const content = stripHtml(html, 12_000);
        if (hasGenuineDetailContent(content, title)) {
          recordDiagnostic(context, {
            code: "direct_success",
            url,
            message: `Direct detail fetch returned ${content.length} genuine content characters.`,
            method: "direct",
          });
          return { content: content.slice(0, 1_200), metadata: {}, method: "direct" };
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
    content: rendered.content.slice(0, 1_200),
    metadata: rendered.metadata,
    method: "crawl4ai",
  };
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

function hasGenuineDetailContent(content: string, title: string): boolean {
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
