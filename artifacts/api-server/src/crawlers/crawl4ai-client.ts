/**
 * Small, deliberately narrow client for a separately hosted Crawl4AI service.
 *
 * This module never enables Crawl4AI's LLM extraction features. The service is
 * used only for browser rendering and selector-free page content/links.
 */
import { createHash } from "node:crypto";

export const CRAWL4AI_SERVER_VERSION_ENV = "CRAWL4AI_SERVER_VERSION";
export const CRAWL4AI_ENDPOINT_ENV = "CRAWL4AI_ENDPOINT";
export const CRAWL4AI_URL_ENV = "CRAWL4AI_URL";
export const CRAWL4AI_API_KEY_ENV = "CRAWL4AI_API_KEY";

export const DEFAULT_CRAWL4AI_TIMEOUT_MS = 20_000;
export const DEFAULT_CRAWL4AI_MAX_RESPONSE_BYTES = 2_000_000;

export type Crawl4AIErrorCode =
  | "disabled"
  | "invalid_config"
  | "timeout"
  | "authentication"
  | "blocked"
  | "off_domain_redirect"
  | "service_unavailable"
  | "malformed_response"
  | "unusable_content"
  | "response_too_large"
  | "version_mismatch";

export class Crawl4AIError extends Error {
  readonly code: Crawl4AIErrorCode;
  readonly url?: string;

  constructor(code: Crawl4AIErrorCode, message: string, url?: string) {
    super(message);
    this.name = "Crawl4AIError";
    this.code = code;
    this.url = url;
  }
}

export interface RenderedPageLink {
  url: string;
  text: string;
  rel?: string;
}

export interface RenderedPageMetadata {
  title?: string;
  description?: string;
  organization?: string;
  deadline?: string;
  [key: string]: string | undefined;
}

export interface RenderedPageResult {
  requestedUrl: string;
  finalUrl: string;
  content: string;
  html?: string;
  links: RenderedPageLink[];
  metadata: RenderedPageMetadata;
  diagnostics: {
    method: "crawl4ai";
    serverVersion: string;
    contentLength: number;
    linkCount: number;
  };
}

export interface Crawl4AIConfig {
  endpoint: string;
  apiKey: string;
  serverVersion: string;
  timeoutMs: number;
  maxResponseBytes: number;
}

export interface Crawl4AIClient {
  readonly config: Readonly<Crawl4AIConfig>;
  render(url: string, approvedDomains: readonly string[]): Promise<RenderedPageResult>;
}

export function normalizeSourceApprovedDomains(
  sourceUrl: string,
  values: unknown,
): string[] {
  let sourceHost: string;
  try {
    sourceHost = new URL(sourceUrl).hostname.toLowerCase();
  } catch {
    throw new Crawl4AIError("invalid_config", "Source URL must be absolute.");
  }
  const sourceRoot = sourceHost.startsWith("www.") ? sourceHost.slice(4) : sourceHost;
  if (values === undefined || values === null) return [sourceRoot];
  if (!Array.isArray(values) || values.length === 0 || values.length > 10) {
    throw new Crawl4AIError(
      "invalid_config",
      "Approved domains must contain between 1 and 10 entries.",
    );
  }

  const domains: string[] = [];
  for (const item of values) {
    if (typeof item !== "string") {
      throw new Crawl4AIError("invalid_config", "Approved domain entries must be strings.");
    }
    const domain = item.trim().toLowerCase().replace(/^\.+/, "");
    if (
      !/^[a-z0-9.-]+$/.test(domain) ||
      domain.includes("..") ||
      domain.split(".").length < 2 ||
      (
        domain !== sourceHost &&
        domain !== sourceRoot &&
        !domain.endsWith(`.${sourceHost}`) &&
        !domain.endsWith(`.${sourceRoot}`)
      )
    ) {
      throw new Crawl4AIError(
        "invalid_config",
        `Approved domain ${domain || "(empty)"} is outside source host ${sourceHost}.`,
      );
    }
    domains.push(domain);
  }
  return [...new Set(domains)];
}

export function getCrawl4AIConfig(
  env: NodeJS.ProcessEnv = process.env,
): Crawl4AIConfig | null {
  const endpointValue = env[CRAWL4AI_ENDPOINT_ENV] ?? env[CRAWL4AI_URL_ENV];
  const apiKey = env[CRAWL4AI_API_KEY_ENV];
  const serverVersion = env[CRAWL4AI_SERVER_VERSION_ENV];

  // Missing configuration is the normal local/development state.
  if (!endpointValue && !apiKey && !serverVersion) return null;
  if (!endpointValue || !apiKey || !serverVersion) {
    throw new Crawl4AIError(
      "invalid_config",
      `Crawl4AI requires ${CRAWL4AI_ENDPOINT_ENV || CRAWL4AI_URL_ENV}, ` +
        `${CRAWL4AI_API_KEY_ENV}, and ${CRAWL4AI_SERVER_VERSION_ENV}.`,
    );
  }

  let endpoint: URL;
  try {
    endpoint = new URL(endpointValue);
  } catch {
    throw new Crawl4AIError("invalid_config", "CRAWL4AI endpoint must be an absolute URL.");
  }
  if (endpoint.protocol !== "https:" && process.env.NODE_ENV === "production") {
    throw new Crawl4AIError(
      "invalid_config",
      "Crawl4AI must use an HTTPS endpoint in production.",
    );
  }

  return {
    endpoint: endpoint.toString(),
    apiKey,
    serverVersion,
    timeoutMs: boundedNumber(
      env.CRAWL4AI_TIMEOUT_MS,
      DEFAULT_CRAWL4AI_TIMEOUT_MS,
      1_000,
      60_000,
    ),
    maxResponseBytes: boundedNumber(
      env.CRAWL4AI_MAX_RESPONSE_BYTES,
      DEFAULT_CRAWL4AI_MAX_RESPONSE_BYTES,
      64_000,
      10_000_000,
    ),
  };
}

export function createCrawl4AIClient(
  config = getCrawl4AIConfig(),
  fetchImpl: typeof fetch = fetch,
): Crawl4AIClient | null {
  if (!config) return null;
  return new HttpCrawl4AIClient(config, fetchImpl);
}

class HttpCrawl4AIClient implements Crawl4AIClient {
  readonly config: Readonly<Crawl4AIConfig>;

  constructor(config: Crawl4AIConfig, private readonly fetchImpl: typeof fetch) {
    this.config = Object.freeze({ ...config });
  }

  async render(
    requestedUrl: string,
    approvedDomains: readonly string[],
  ): Promise<RenderedPageResult> {
    const target = parseApprovedUrl(requestedUrl, approvedDomains);
    const normalizedDomains = [...new Set(approvedDomains.map((domain) =>
      domain.toLowerCase().replace(/^\.+/, ""),
    ))].sort();
    const policyDigest = createDomainPolicyDigest(normalizedDomains);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(this.config.endpoint, {
        method: "POST",
        redirect: "manual",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Crawl4AI-Expected-Version": this.config.serverVersion,
          "X-Crawl4AI-Domain-Policy": policyDigest,
          "User-Agent": "ONWRD-TenderBot/1.0",
        },
        // Deliberately no extraction strategy, LLM provider, or arbitrary
        // browser code. This is a render-and-return-content request only.
        body: JSON.stringify({
          urls: [target.toString()],
          crawler_config: {
            cache_mode: "bypass",
            word_count_threshold: 1,
            exclude_external_links: false,
          },
          browser_config: {
            java_script_enabled: true,
          },
          // Required contract for the hardened Crawl4AI gateway. The service
          // must validate every main-frame/subresource navigation and redirect
          // before request dispatch, and block private/link-local networks.
          security_policy: {
            allowed_domains: normalizedDomains,
            validate_redirects_before_request: true,
            block_private_networks: true,
            block_link_local_networks: true,
          },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      if (isAbortError(error)) {
        throw new Crawl4AIError("timeout", `Crawl4AI timed out rendering ${target}.`, target.toString());
      }
      throw new Crawl4AIError(
        "service_unavailable",
        `Crawl4AI request failed for ${target}: ${error instanceof Error ? error.message : String(error)}`,
        target.toString(),
      );
    }
    try {
      if (response.status >= 300 && response.status < 400) {
        throw new Crawl4AIError(
          "service_unavailable",
          `Crawl4AI returned an unexpected redirect (${response.status}).`,
          target.toString(),
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new Crawl4AIError(
          "authentication",
          `Crawl4AI rejected the request with HTTP ${response.status}.`,
          target.toString(),
        );
      }
      if (response.status === 429 || response.status >= 500) {
        throw new Crawl4AIError(
          "service_unavailable",
          `Crawl4AI returned HTTP ${response.status}.`,
          target.toString(),
        );
      }
      if (!response.ok) {
        throw new Crawl4AIError(
          "blocked",
          `Crawl4AI returned HTTP ${response.status}.`,
          target.toString(),
        );
      }

      const responseVersion =
        response.headers.get("x-crawl4ai-version") ??
        response.headers.get("x-server-version");
      if (responseVersion !== this.config.serverVersion) {
        throw new Crawl4AIError(
          "version_mismatch",
          responseVersion
            ? `Crawl4AI server version ${responseVersion} does not match pinned ${this.config.serverVersion}.`
            : "Crawl4AI response did not attest its server version.",
          target.toString(),
        );
      }
      const attestedPolicy = response.headers.get("x-crawl4ai-domain-policy");
      if (attestedPolicy !== policyDigest) {
        throw new Crawl4AIError(
          "blocked",
          attestedPolicy
            ? "Crawl4AI server attested a different domain policy."
            : "Crawl4AI server did not attest redirect/domain policy enforcement.",
          target.toString(),
        );
      }

      try {
        const body = await readBoundedBody(response, this.config.maxResponseBytes, target.toString());
        const payload = parseJson(body, target.toString());
        const result = normalizeResult(payload, target.toString(), this.config, approvedDomains);
        const finalUrl = parseApprovedUrl(result.finalUrl, approvedDomains);
        return { ...result, finalUrl: finalUrl.toString() };
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) {
          throw new Crawl4AIError(
            "timeout",
            `Crawl4AI timed out rendering ${target}.`,
            target.toString(),
          );
        }
        throw error;
      }
    } finally {
      // Keep the abort deadline active until the entire bounded response body
      // has been consumed, not merely until response headers arrive.
      clearTimeout(timeout);
    }
  }
}

function normalizeResult(
  payload: unknown,
  requestedUrl: string,
  config: Crawl4AIConfig,
  approvedDomains: readonly string[],
): Omit<RenderedPageResult, "finalUrl"> & { finalUrl: string } {
  const candidate = Array.isArray(payload)
    ? payload[0]
    : isRecord(payload) && Array.isArray(payload.results)
      ? payload.results[0]
      : payload;

  if (!isRecord(candidate)) {
    throw new Crawl4AIError("malformed_response", "Crawl4AI response was not an object.", requestedUrl);
  }
  if (candidate.success === false) {
    const status = Number(candidate.status_code ?? 0);
    throw new Crawl4AIError(
      status === 401 || status === 403 ? "authentication" : "blocked",
      `Crawl4AI could not render ${requestedUrl}: ${String(candidate.error ?? "unknown error")}`,
      requestedUrl,
    );
  }

  const html = asNonEmptyString(candidate.cleaned_html) ?? asNonEmptyString(candidate.html);
  const content =
    asNonEmptyString(candidate.markdown) ??
    asNonEmptyString(candidate.fit_markdown) ??
    (html ? simplifyHtml(html) : "");
  const links = normalizeLinks(candidate.links, requestedUrl, approvedDomains);
  const metadata = normalizeMetadata(candidate.metadata);
  const finalUrl =
    asNonEmptyString(candidate.final_url) ??
    asNonEmptyString(candidate.url) ??
    requestedUrl;

  if (content.trim().length < 80 && links.length === 0) {
    throw new Crawl4AIError(
      "unusable_content",
      `Crawl4AI returned unusable content for ${requestedUrl}.`,
      requestedUrl,
    );
  }

  return {
    requestedUrl,
    finalUrl,
    content: normalizeContent(content),
    html,
    links,
    metadata,
    diagnostics: {
      method: "crawl4ai",
      serverVersion: config.serverVersion,
      contentLength: content.length,
      linkCount: links.length,
    },
  };
}

function normalizeLinks(
  value: unknown,
  baseUrl: string,
  approvedDomains: readonly string[],
): RenderedPageLink[] {
  const values: unknown[] = [];
  if (Array.isArray(value)) values.push(...value);
  else if (isRecord(value)) {
    for (const group of Object.values(value)) {
      if (Array.isArray(group)) values.push(...group);
    }
  }

  const links: RenderedPageLink[] = [];
  for (const item of values) {
    if (typeof item === "string") {
      const url = resolveUrl(item, baseUrl);
      if (url && isApprovedUrl(url, approvedDomains)) links.push({ url, text: url });
      continue;
    }
    if (!isRecord(item)) continue;
    const href = asNonEmptyString(item.href) ?? asNonEmptyString(item.url);
    if (!href) continue;
    const url = resolveUrl(href, baseUrl);
    if (!url || !isApprovedUrl(url, approvedDomains)) continue;
    links.push({
      url,
      text: asNonEmptyString(item.text) ?? asNonEmptyString(item.title) ?? url,
      rel: asNonEmptyString(item.rel),
    });
  }
  return dedupeLinks(links);
}

function normalizeMetadata(value: unknown): RenderedPageMetadata {
  if (!isRecord(value)) return {};
  const metadata: RenderedPageMetadata = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string" && raw.trim()) metadata[key] = raw.trim().slice(0, 500);
    else if (typeof raw === "number" || typeof raw === "boolean") metadata[key] = String(raw);
  }
  return metadata;
}

function parseApprovedUrl(value: string, approvedDomains: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Crawl4AIError("off_domain_redirect", `Invalid rendered URL: ${value}.`, value);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Crawl4AIError("off_domain_redirect", `Unsupported rendered URL protocol: ${url.protocol}.`, value);
  }
  if (!isApprovedUrl(url.toString(), approvedDomains)) {
    throw new Crawl4AIError(
      "off_domain_redirect",
      `Crawl4AI rendered off-domain URL ${url.hostname}; approved domains: ${approvedDomains.join(", ")}.`,
      value,
    );
  }
  return url;
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

function resolveUrl(value: string, baseUrl: string): string | null {
  try {
    const url = new URL(value, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  url: string,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > maxBytes) {
    throw new Crawl4AIError(
      "response_too_large",
      `Crawl4AI response exceeds the ${maxBytes}-byte limit.`,
      url,
    );
  }

  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Crawl4AIError("response_too_large", "Crawl4AI response exceeded the size limit.", url);
    }
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
        throw new Crawl4AIError("response_too_large", "Crawl4AI response exceeded the size limit.", url);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function parseJson(body: string, url: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Crawl4AIError("malformed_response", "Crawl4AI returned invalid JSON.", url);
  }
}

function simplifyHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function normalizeContent(content: string): string {
  return content
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 12_000);
}

function dedupeLinks(links: RenderedPageLink[]): RenderedPageLink[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    if (seen.has(link.url)) return false;
    seen.add(link.url);
    return true;
  });
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

export function createDomainPolicyDigest(approvedDomains: readonly string[]): string {
  const policy = JSON.stringify({
    allowedDomains: [...new Set(approvedDomains.map((domain) =>
      domain.toLowerCase().replace(/^\.+/, ""),
    ))].sort(),
    validateRedirectsBeforeRequest: true,
    blockPrivateNetworks: true,
    blockLinkLocalNetworks: true,
  });
  return createHash("sha256").update(policy).digest("hex");
}