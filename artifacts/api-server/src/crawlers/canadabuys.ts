import {
  AdapterFetchContext,
  TenderOpportunity,
  TenderSourceAdapter,
  fetchApprovedText,
  stripHtml,
} from "./base-adapter.js";
import { findCoreServicePhrases } from "../lib/crawler-eligibility.js";

// CanadaBuys adapter.
//
// The Government of Canada publishes every open federal tender as one
// open-data file (Open Government Licence). It holds ~900 notices; only the
// handful that name a marketing/communications service are kept.
const CANADABUYS_ORIGIN = "https://canadabuys.canada.ca";
const OPEN_NOTICES_URL = `${CANADABUYS_ORIGIN}/opendata/pub/openTenderNotice-ouvertAvisAppelOffres.csv`;
const CANADABUYS_DOMAINS = ["canadabuys.canada.ca"];
const MAX_NOTICES_PER_RUN = 20;

const TITLE_SERVICE = /\b(?:marketing|advertis\w+|public relations|social media|branding|rebrand\w*|media (?:buying|relations|planning|agency)|creative (?:services|agency)|graphic design|video production|communications? (?:strategy|services|support|plan|campaign|agency)|awareness campaign|tourism)\b/i;

/** Parse CSV text with quoted fields, embedded commas and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === "\"") {
        if (source[i + 1] === "\"") { field += "\""; i++; } else quoted = false;
      } else field += char;
    } else if (char === "\"") quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += char;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/** Turn the open-notices file into the marketing/communications tenders still open. */
export function selectCanadaBuysNotices(csvText: string, now = new Date()): TenderOpportunity[] {
  const rows = parseCsv(csvText);
  const header = rows[0] ?? [];
  const column = (name: string) => header.indexOf(name);
  const col = {
    title: column("title-titre-eng"),
    reference: column("referenceNumber-numeroReference"),
    closing: column("tenderClosingDate-appelOffresDateCloture"),
    status: column("tenderStatus-appelOffresStatut-eng"),
    type: column("noticeType-avisType-eng"),
    entity: column("contractingEntityName-nomEntitContractante-eng"),
    url: column("noticeURL-URLavis-eng"),
    description: column("tenderDescription-descriptionAppelOffres-eng"),
    category: column("unspscDescription-eng"),
  };
  if (col.title < 0 || col.closing < 0 || col.reference < 0) {
    throw new Error("CanadaBuys open-notices file no longer has the expected columns.");
  }
  const results: TenderOpportunity[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(1)) {
    const get = (index: number) => (index >= 0 ? (row[index] ?? "").trim() : "");
    const title = get(col.title).replace(/_/g, " ").replace(/\s+/g, " ");
    const reference = get(col.reference);
    if (!title || !reference || seen.has(reference)) continue;
    if (/cancel|expired|award/i.test(get(col.status))) continue;
    if (!TITLE_SERVICE.test(title) && findCoreServicePhrases(title).length === 0) continue;
    const deadline = new Date(get(col.closing));
    if (Number.isNaN(deadline.getTime()) || deadline <= now) continue;
    seen.add(reference);
    const entity = get(col.entity) || "Government of Canada";
    const details = stripHtml(get(col.description), 3_500).replace(/\s+/g, " ").trim();
    const listedUrl = get(col.url);
    results.push({
      externalId: `canadabuys-${reference}`,
      title,
      organization: entity,
      url: /^https:\/\//i.test(listedUrl)
        ? listedUrl
        : `${CANADABUYS_ORIGIN}/en/tender-opportunities/tender-notice/${encodeURIComponent(reference)}`,
      deadline,
      description: [
        `${title}.`,
        `Buyer: ${entity}.`,
        get(col.type) ? `Notice type: ${get(col.type)}.` : "",
        get(col.category) ? `Category: ${get(col.category).replace(/\s+/g, " ").slice(0, 200)}.` : "",
        details,
      ].filter(Boolean).join(" ").slice(0, 4_000),
      country: "Canada",
      sector: "Government Procurement",
      rawData: {
        sourcePage: OPEN_NOTICES_URL,
        referenceNumber: reference,
        extractionMethod: "open_data_file",
        descriptionStatus: details.length >= 120 ? "substantive" : "insufficient_scope",
      },
    });
    if (results.length >= MAX_NOTICES_PER_RUN) break;
  }
  return results;
}

export class CanadaBuysAdapter implements TenderSourceAdapter {
  adapterType = "canadabuys";

  async fetchOpportunities(context?: AdapterFetchContext): Promise<TenderOpportunity[]> {
    const file = await fetchApprovedText(OPEN_NOTICES_URL, CANADABUYS_DOMAINS, 40_000_000, {
      headers: { Accept: "text/csv, */*" },
    });
    if (!file.response.ok) {
      throw new Error(`CanadaBuys open-notices file returned HTTP ${file.response.status}.`);
    }
    const results = selectCanadaBuysNotices(file.text);
    context?.diagnostics?.push({
      code: "direct_success",
      url: OPEN_NOTICES_URL,
      message: `Kept ${results.length} open marketing/communications notices from the federal open-data file.`,
      method: "direct",
    });
    return results;
  }
}
