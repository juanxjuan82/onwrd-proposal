import {
  hasSubstantiveScope,
  TenderOpportunity,
} from "./base-adapter.js";

export interface ExistingDiscovery {
  title: string;
  organization: string;
  description: string;
  status: string;
  opportunityId: number | null;
  deadline: Date | null;
  country: string | null;
  sector: string | null;
  rawData: unknown;
}

const CRAWLER_EVIDENCE_KEYS = [
  "sourcePage",
  "noticeUrl",
  "listingContext",
  "extractionMethod",
  "detailFetchStatus",
  "descriptionStatus",
  "documentStatus",
  "documentExtraction",
  "documentUrls",
  "needsEnrichment",
  "crawlerFingerprint",
  "crawlerManagedSnapshot",
  "adapterContext",
  "renderedMetadata",
] as const;

export function isIncompleteDiscovery(existing: ExistingDiscovery): boolean {
  const raw = asObject(existing.rawData);
  return raw.needsEnrichment === true || !hasSubstantiveScope(existing.description, existing.title);
}

export function canRefreshIncompleteDiscovery(
  existing: ExistingDiscovery,
  incoming: TenderOpportunity,
): boolean {
  return existing.opportunityId === null
    && existing.status === "new"
    && asObject(existing.rawData).userEdited !== true
    && isIncompleteDiscovery(existing)
    && hasCrawlerOwnedDescription(existing)
    && hasSubstantiveScope(incoming.description, incoming.title)
    && incoming.description.length > existing.description.length;
}

function hasCrawlerOwnedDescription(existing: ExistingDiscovery): boolean {
  const raw = asObject(existing.rawData);
  const snapshot = asObject(raw.crawlerManagedSnapshot);
  if (typeof snapshot.description === "string") {
    return snapshot.description.trim() === existing.description.trim();
  }
  const listingContext = typeof raw.listingContext === "string" ? raw.listingContext.trim() : "";
  if (listingContext && listingContext === existing.description.trim()) return true;
  const title = escapeRegExp(existing.title.trim());
  const safeTitle = title || ".+";
  return new RegExp(
    `^(?:(?:CDB|UNDP|CARICOM Secretariat)\\s+(?:procurement notice|announcement):\\s*${safeTitle}|(?:no description available|n/a|tbd|see attached|see document))\\.?$`,
    "i",
  ).test(existing.description.trim()) || existing.description.trim() === existing.title.trim();
}

/** Preserve user-owned values and only refresh crawler-owned evidence fields. */
export function mergeCrawlerRawData(
  existingValue: unknown,
  incomingValue: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const existing = asObject(existingValue);
  if (!incomingValue) return existing;
  const merged = { ...existing };
  for (const key of CRAWLER_EVIDENCE_KEYS) {
    if (Object.hasOwn(incomingValue, key)) merged[key] = incomingValue[key];
  }
  return merged;
}

export function mergeDocumentEvidence(
  existingRaw: Record<string, unknown>,
  incomingRaw: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const existingDocs = asDocuments(existingRaw.documentExtraction);
  const incomingDocs = asDocuments(incomingRaw?.documentExtraction);
  if (incomingDocs.length === 0) return undefined;

  const byUrl = new Map<string, Record<string, unknown>>();
  for (const item of existingDocs) {
    if (typeof item.url === "string") byUrl.set(item.url, item);
  }
  let changed = false;
  for (const item of incomingDocs) {
    if (typeof item.url !== "string") continue;
    const previous = byUrl.get(item.url);
    const previousText = typeof previous?.extractedText === "string" ? previous.extractedText : "";
    const incomingText = typeof item.extractedText === "string" ? item.extractedText : "";
    const next = previousText && !incomingText
      ? { ...item, ...previous }
      : { ...previous, ...item };
    if (JSON.stringify(previous ?? null) !== JSON.stringify(next)) changed = true;
    byUrl.set(item.url, next);
  }
  return changed ? { ...existingRaw, documentExtraction: [...byUrl.values()] } : undefined;
}

export function sameDiscovery(
  existing: { externalId: string | null; url: string | null },
  incoming: { externalId?: string; url?: string },
): boolean {
  if (existing.externalId && incoming.externalId && existing.externalId === incoming.externalId) return true;
  return Boolean(existing.url && incoming.url && normalizeNoticeUrl(existing.url) === normalizeNoticeUrl(incoming.url));
}

function normalizeNoticeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return value.trim();
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function asDocuments(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
        Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : [];
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
