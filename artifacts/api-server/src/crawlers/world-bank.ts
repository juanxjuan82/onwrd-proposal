import { TenderSourceAdapter, TenderOpportunity, safeFetch, stripHtml } from "./base-adapter.js";

// Field names from the World Bank procnotices API (re-verified Nov 2026).
// IMPORTANT: `submission_date` is when the notice was PUBLISHED.
// The bidding deadline is `submission_deadline_date`.
interface WBNotice {
  id?: string;
  project_id?: string;
  project_name?: string;
  bid_reference_no?: string;
  bid_description?: string;
  notice_text?: string;
  submission_date?: string;
  submission_deadline_date?: string;
  project_ctry_name?: string;
  notice_type?: string;
  notice_lang_name?: string;
  procurement_method_name?: string;
  contact_organization?: string;
  [key: string]: unknown;
}

// Caribbean/SIDS country names as they appear in project_ctry_name
const CARIBBEAN_COUNTRIES = [
  "Bahamas", "Jamaica", "Barbados", "Trinidad and Tobago", "Guyana",
  "Saint Lucia", "St. Lucia", "Saint Vincent", "St. Vincent and the Grenadines",
  "Grenada", "Antigua and Barbuda", "Belize", "Haiti", "Dominican Republic",
  "Turks and Caicos", "Cayman Islands", "Suriname", "Dominica",
  "St. Kitts and Nevis", "Caribbean", "OECS Countries",
];

const FIELDS =
  "id,project_id,project_name,bid_reference_no,bid_description,project_ctry_name," +
  "submission_date,submission_deadline_date,notice_text,notice_type,notice_lang_name," +
  "procurement_method_name,contact_organization";

// Free-text searches for the worldwide pass — only comms-style work is worth
// pulling from outside the Caribbean.
const GLOBAL_TERMS = [
  '"communication strategy"',
  '"communications strategy"',
  '"communication campaign"',
  '"awareness campaign"',
  '"public relations"',
  '"social media"',
  '"branding"',
  '"marketing"',
];

export class WorldBankAdapter implements TenderSourceAdapter {
  adapterType = "world_bank";
  // The API already returns the full notice text — no need to open each page.
  skipDetailFetch = true;

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    const queries: Array<{ params: string; label: string }> = [
      { params: `&rows=50&fq=${encodeURIComponent("project_ctry_name:Bahamas")}`, label: "Bahamas" },
      {
        params: `&rows=100&fq=${encodeURIComponent(
          `project_ctry_name:(${CARIBBEAN_COUNTRIES.map((c) => `"${c}"`).join(" OR ")})`,
        )}`,
        label: "Caribbean",
      },
      ...GLOBAL_TERMS.map((t) => ({
        params: `&rows=25&qterm=${encodeURIComponent(t)}`,
        label: "Global",
      })),
    ];

    const seen = new Set<string>();
    const results: TenderOpportunity[] = [];
    let okCount = 0;
    let lastError: Error | undefined;
    const now = Date.now();

    for (const { params, label } of queries) {
      const url =
        `https://search.worldbank.org/api/v2/procnotices?format=json` +
        `&fl=${FIELDS}&srt=submission_date&order=desc${params}`;

      try {
        const r = await safeFetch(url, { headers: { Accept: "application/json" } });
        if (!r.ok) throw new Error(`World Bank API answered HTTP ${r.status}`);

        const data = (await r.json()) as { procnotices?: WBNotice[] };
        okCount++;

        for (const n of data?.procnotices ?? []) {
          const noticeId = String(n.id ?? "");
          const projectId = String(n.project_id ?? "");
          const id = noticeId || projectId;
          if (!id || seen.has(id)) continue;
          seen.add(id);

          // Award notices are results, not opportunities.
          if (/award/i.test(String(n.notice_type ?? ""))) continue;
          // The team works in English.
          if (n.notice_lang_name && !/english/i.test(String(n.notice_lang_name))) continue;

          const deadline = n.submission_deadline_date
            ? new Date(String(n.submission_deadline_date))
            : undefined;
          const validDeadline = deadline && !isNaN(deadline.getTime()) ? deadline : undefined;
          // Don't store notices that have already closed.
          if (validDeadline && validDeadline.getTime() < now) continue;

          const countryName = String(n.project_ctry_name ?? label);
          const projectName = stripHtml(String(n.project_name ?? ""), 300);
          const bidTitle = stripHtml(String(n.bid_description ?? ""), 300);
          const body = stripHtml(String(n.notice_text ?? ""), 3600);

          const description = [
            projectName ? `Project: ${projectName}.` : "",
            n.procurement_method_name ? `Method: ${n.procurement_method_name}.` : "",
            `Country: ${countryName}.`,
            body,
          ].filter(Boolean).join(" ");

          results.push({
            externalId: `wb-${id}`,
            // The bid description is the actual assignment; the project name is
            // shared by every notice in the same project.
            title: bidTitle || projectName || "World Bank Procurement Notice",
            organization: n.contact_organization
              ? `${stripHtml(String(n.contact_organization), 150)} (World Bank-financed)`
              : "World Bank",
            url: noticeId
              ? `https://projects.worldbank.org/en/projects-operations/procurement-detail/${noticeId}`
              : `https://projects.worldbank.org/en/projects-operations/project-detail/${projectId}`,
            deadline: validDeadline,
            description,
            country: countryName,
            sector: String(n.notice_type ?? "Procurement"),
            rawData: { ...n, notice_text: undefined } as Record<string, unknown>,
          });
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    if (okCount === 0 && lastError) throw lastError;
    return results;
  }
}
