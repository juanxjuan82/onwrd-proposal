import { createHash } from "node:crypto";

/** Canonicalize crawler URLs without changing the identity of a real page. */
export function normalizeCrawlerUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    url.hash = "";
    // Tracking/session parameters are not part of a tender's identity.
    const ignored = /^(utm_[^=]+|fbclid|gclid|mc_cid|mc_eid|_ga|session(id)?|sid)$/i;
    for (const key of [...url.searchParams.keys()]) {
      if (ignored.test(key)) url.searchParams.delete(key);
    }
    const params = [...url.searchParams.entries()].sort(([a, av], [b, bv]) =>
      a.localeCompare(b) || av.localeCompare(bv));
    url.search = "";
    for (const [key, val] of params) url.searchParams.append(key, val);
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return null;
  }
}

/** Stable content identity for records which have no reliable external ID. */
export function crawlerContentFingerprint(input: {
  sourceId?: number | string;
  title: string;
  organization: string;
  description?: string;
  url?: string | null;
  externalId?: string | null;
  deadline?: Date | string | null;
}): string {
  const canonicalUrl = normalizeCrawlerUrl(input.url ?? "");
  const stableIdentity = input.externalId
    ? `external:${input.externalId}`
    : canonicalUrl
      ? `url:${canonicalUrl}`
      : `content:${normalizeText(input.title)}\u001f${normalizeText(input.organization)}\u001f${normalizeDate(input.deadline)}`;
  const normalized = [
    input.sourceId ?? "",
    stableIdentity,
  ].join("\u001f");
  return createHash("sha256").update(normalized).digest("hex");
}

function normalizeDate(value: Date | string | null | undefined): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value).slice(0, 32) : date.toISOString();
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}
/**
 * Collision-safe external ID for a crawled notice. Hashes the WHOLE identity
 * (normally the notice URL), so two notices whose URLs or titles merely start
 * the same way never share an ID.
 *
 * Do not build IDs by truncating an encoded title/URL: a 16-character base64
 * slice keeps only the first 12 characters (for a URL that is "https://www."),
 * and the crawl loop treats a matching externalId as an existing record, so
 * every later notice from that source was silently dropped as a duplicate.
 */
export function stableExternalId(prefix: string, ...parts: Array<string | null | undefined>): string {
  const identity = parts
    .map((part) => {
      const value = (part ?? "").trim();
      return normalizeCrawlerUrl(value) ?? normalizeText(value);
    })
    .join("\u001f");
  return `${prefix}-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}
