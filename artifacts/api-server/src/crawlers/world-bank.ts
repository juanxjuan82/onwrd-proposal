import { TenderSourceAdapter, TenderOpportunity, safeFetch, stripHtml } from "./base-adapter.js";

// World Bank Procurement Notices adapter.
//
// API: https://search.worldbank.org/api/v2/procnotices
//
// Key design decisions:
//  • submission_deadline_date is the ACTUAL bid deadline.
//    submission_date is the notice PUBLICATION date — never use it as a deadline.
//  • Filtering (verified live, Nov 2026): the `fq` Solr filter and the `q`
//    parameter do NOT narrow results — they return the newest notices from the
//    whole 420k+ dataset, which is why earlier runs stored ambulances for
//    Rwanda. The parameters that genuinely filter are:
//      - project_ctry_name_exact=A^B^C   (exact country names, ^ = OR)
//      - notice_type_exact=A^B           (exact notice types, ^ = OR)
//      - qterm="some phrase"             (full-text search, quotes = phrase)
//  • Two kinds of passes:
//      1. Every open notice for Caribbean countries (small set; scored later).
//      2. Worldwide notices that mention a communications/marketing service.
//  • Only notices with a future submission deadline are returned: contract
//    awards and general notices have none and cannot be bid on.
interface WBNotice {
  id?: string;
  project_id?: string;
  project_name?: string;
  bid_description?: string;
  notice_text?: string;
  submission_date?: string;
  submission_deadline_date?: string;
  project_ctry_name?: string;
  notice_type?: string;
  procurement_group?: string;
  procurement_method_name?: string;
  [key: string]: unknown;
}

const API_URL = "https://search.worldbank.org/api/v2/procnotices";
const FIELDS = [
  "id", "project_id", "project_name", "bid_description", "project_ctry_name",
  "submission_date", "submission_deadline_date", "notice_text", "notice_type",
  "procurement_group", "procurement_method_name",
].join(",");

// Country names exactly as the World Bank API spells them. Names that return
// nothing (the API has no Bahamas notices today) are harmless.
export const WORLD_BANK_CARIBBEAN_COUNTRIES = [
  "Bahamas", "The Bahamas", "Bahamas, The",
  "Caribbean", "OECS Countries",
  "Jamaica", "Barbados", "Belize", "Guyana", "Suriname", "Haiti",
  "Trinidad and Tobago", "Grenada", "Dominica", "St. Lucia",
  "St. Vincent and the Grenadines", "St. Kitts and Nevis",
  "Antigua and Barbuda", "Dominican Republic",
] as const;

// Notice types that invite a bid. "Contract Award" and "General Procurement
// Notice" are announcements, not opportunities.
const BIDDABLE_NOTICE_TYPES = [
  "Request for Expression of Interest",
  "Invitation for Bids",
  "Request for Proposals",
  "Request for Bids",
] as const;

// Worldwide full-text searches. Quoted values are matched as a phrase.
export const WORLD_BANK_SERVICE_TERMS = [
  "\"communication strategy\"",
  "\"communications strategy\"",
  "\"communication campaign\"",
  "\"awareness campaign\"",
  "\"media campaign\"",
  "\"public relations\"",
  "\"social media\"",
  "\"behavior change\"",
  "marketing",
  "branding",
] as const;

function orList(values: readonly string[]): string {
  return values.map((value) => encodeURIComponent(value)).join("^");
}

function buildUrl(params: string, rows: number): string {
  return `${API_URL}?format=json&rows=${rows}&fl=${FIELDS}&srt=noticedate&order=desc&${params}`;
}

function clean(value: unknown, maxLen: number): string {
  return stripHtml(String(value ?? ""), maxLen)
    .replace(/&(?:rdquo|ldquo|quot);/g, "\"")
    .replace(/&(?:rsquo|lsquo|#39|apos);/g, "'")
    .replace(/&(?:ndash|mdash);/g, "-")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * ONWRD bids in English. Notices written in Portuguese, Spanish or French
 * (Angola, Dominican Republic, Burundi…) still match words like "marketing",
 * so compare how many everyday English vs. Romance-language words appear.
 */
export function looksEnglish(text: string): boolean {
  const sample = ` ${text.toLowerCase().slice(0, 2_500)} `;
  const count = (words: string[]) =>
    words.reduce((sum, word) => sum + (sample.split(` ${word} `).length - 1), 0);
  const english = count(["the", "and", "of", "for", "to", "in", "with", "will", "is"]);
  const romance = count([
    "de", "la", "el", "los", "las", "para", "del", "que", "y", "en",
    "da", "do", "dos", "das", "uma", "com", "e", "os",
    "le", "les", "des", "du", "pour", "et", "une", "dans",
  ]);
  return english >= romance;
}

export class WorldBankAdapter implements TenderSourceAdapter {
  adapterType = "world_bank";

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    const noticeTypes = `notice_type_exact=${orList(BIDDABLE_NOTICE_TYPES)}`;
    const queries: Array<{ url: string; label: string }> = [
      {
        label: "Caribbean countries",
        url: buildUrl(
          `project_ctry_name_exact=${orList(WORLD_BANK_CARIBBEAN_COUNTRIES)}&${noticeTypes}`,
          200,
        ),
      },
      ...WORLD_BANK_SERVICE_TERMS.map((term) => ({
        label: `worldwide ${term}`,
        url: buildUrl(`qterm=${encodeURIComponent(term)}&${noticeTypes}`, 50),
      })),
    ];

    const seen = new Set<string>();
    const results: TenderOpportunity[] = [];
    const warnings: string[] = [];
    let requestsAttempted = 0;
    let requestsSucceeded = 0;
    const now = new Date();

    for (const { url, label } of queries) {
      requestsAttempted++;

      let r: Response;
      try {
        r = await safeFetch(url, {
          headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
        });
      } catch (err) {
        warnings.push(`World Bank ${label}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      if (!r.ok) {
        warnings.push(`World Bank ${label} HTTP ${r.status}`);
        continue;
      }

      let data: { procnotices?: WBNotice[] | Record<string, WBNotice> };
      try {
        data = (await r.json()) as typeof data;
      } catch (err) {
        warnings.push(`World Bank ${label} JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      requestsSucceeded++;
      const notices = Object.values(data?.procnotices ?? {});

      for (const n of notices) {
        const id = String(n.id ?? n.project_id ?? "");
        if (!id || seen.has(id)) continue;
        if (/contract award/i.test(String(n.notice_type ?? ""))) continue;

        // submission_deadline_date is the actual bid deadline. A notice with
        // no deadline cannot be acted on, so it is not an opportunity.
        const deadlineStr = String(n.submission_deadline_date ?? "").trim();
        if (!deadlineStr) continue;
        const deadline = new Date(deadlineStr);
        if (Number.isNaN(deadline.getTime())) continue;

        // Skip notices with an expired deadline.
        if (deadline <= now) continue;

        seen.add(id);

        const countryName = clean(n.project_ctry_name, 120);
        const projectName = clean(n.project_name, 250);
        // bid_description is the name of the actual contract being tendered;
        // project_name is the umbrella programme and says nothing about the work.
        const contractTitle = clean(n.bid_description, 250);
        const title = contractTitle || projectName || "World Bank Procurement Notice";
        const noticeText = clean(n.notice_text, 6_000);
        const description = [
          contractTitle && projectName ? `Project: ${projectName}.` : "",
          countryName ? `Country: ${countryName}.` : "",
          n.notice_type ? `Notice type: ${clean(n.notice_type, 80)}.` : "",
          n.procurement_method_name ? `Method: ${clean(n.procurement_method_name, 120)}.` : "",
          noticeText,
        ].filter(Boolean).join(" ").slice(0, 4_000);
        if (!looksEnglish(`${title} ${noticeText}`)) continue;
        const projectId = String(n.project_id ?? "");
        const noticeId = String(n.id ?? "");

        results.push({
          externalId: `wb-${noticeId || projectId}`,
          title,
          organization: "World Bank",
          url: noticeId
            ? `https://projects.worldbank.org/en/projects-operations/procurement/noticedetails?id=${noticeId}`
            : projectId
            ? `https://projects.worldbank.org/en/projects-operations/project-detail/${projectId}`
            : "https://projects.worldbank.org/en/projects-operations/procurement",
          deadline,
          description,
          country: countryName,
          sector: n.notice_type ?? "Procurement",
          rawData: { ...(n as Record<string, unknown>), matchedQuery: label },
        });
      }
    }

    if (warnings.length > 0) {
      console.warn(`[WorldBankAdapter] ${warnings.join("; ")}`);
    }

    // Throw if every request failed — caller records a failed source run.
    if (requestsAttempted > 0 && requestsSucceeded === 0) {
      throw new Error(`World Bank API: all ${requestsAttempted} requests failed. ` + warnings.join("; "));
    }

    return results;
  }
}
