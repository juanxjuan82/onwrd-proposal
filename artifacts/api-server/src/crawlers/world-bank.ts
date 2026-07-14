import { TenderSourceAdapter, TenderOpportunity, safeFetch } from "./base-adapter.js";

// Correct field names from World Bank procnotices API (verified Jul 2026):
// id, notice_type, noticedate, project_id, project_name, bid_reference_no,
// bid_description, project_ctry_name, submission_date, notice_text
interface WBNotice {
  id?: string;
  project_id?: string;
  project_name?: string;
  bid_reference_no?: string;
  bid_description?: string;
  notice_text?: string;
  submission_date?: string;
  project_ctry_name?: string;
  notice_type?: string;
  procurement_method_name?: string;
  [key: string]: unknown;
}

// Caribbean/SIDS country names as they appear in project_ctry_name
const CARIBBEAN_COUNTRIES = [
  "Bahamas", "Jamaica", "Barbados", "Trinidad and Tobago", "Guyana",
  "Saint Lucia", "Saint Vincent", "Grenada", "Antigua and Barbuda",
  "Belize", "Haiti", "Dominican Republic", "Turks and Caicos",
  "Cayman Islands", "Suriname", "Dominica", "St. Kitts and Nevis",
];

export class WorldBankAdapter implements TenderSourceAdapter {
  adapterType = "world_bank";

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    // World Bank procnotices API: q param is not reliable for filtering.
    // Use fq (Solr filter query) with project_ctry_name for country targeting.
    // Fetch Bahamas-specific first, then Caribbean-wide comms work.
    const queries: Array<{ fq: string; label: string }> = [
      // Bahamas-specific — highest priority
      { fq: "project_ctry_name:Bahamas", label: "Bahamas" },
      // Broader Caribbean comms/tourism
      {
        fq: `project_ctry_name:(${CARIBBEAN_COUNTRIES.map((c) => `"${c}"`).join(" OR ")})`,
        label: "Caribbean",
      },
      // Global comms/marketing (no country filter) — for high-value remote-eligible work
      { fq: "", label: "Global" },
    ];

    const seen = new Set<string>();
    const results: TenderOpportunity[] = [];

    for (const { fq, label } of queries) {
      // For the global pass, only take comms/tourism notices — use notice_text filter
      const base =
        `https://search.worldbank.org/api/v2/procnotices` +
        `?format=json&rows=20` +
        `&fl=id,project_id,project_name,bid_reference_no,bid_description,project_ctry_name,submission_date,notice_text,notice_type` +
        `&srt=submission_date&order=desc`;

      const url = fq ? `${base}&fq=${encodeURIComponent(fq)}` : base;

      try {
        const r = await safeFetch(url, {
          headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
        });
        if (!r.ok) continue;

        const data = (await r.json()) as { procnotices?: WBNotice[]; total?: number };
        const notices = data?.procnotices ?? [];

        for (const n of notices) {
          const id = String(n.id ?? n.project_id ?? "");
          if (!id || seen.has(id)) continue;
          seen.add(id);

          const countryName = String(n.project_ctry_name ?? label);
          const description = String(
            n.bid_description ?? n.notice_text ?? n.project_name ?? ""
          ).slice(0, 600);
          const projectId = String(n.project_id ?? "");
          const noticeId = String(n.id ?? "");

          results.push({
            externalId: `wb-${noticeId || projectId}`,
            title: String(n.project_name ?? n.bid_description ?? "World Bank Procurement Notice"),
            organization: "World Bank",
            url: noticeId
              ? `https://projects.worldbank.org/en/projects-operations/procurement/noticedetails?id=${noticeId}`
              : projectId
              ? `https://projects.worldbank.org/en/projects-operations/project-detail/${projectId}`
              : "https://projects.worldbank.org/en/projects-operations/procurement",
            deadline: n.submission_date ? new Date(String(n.submission_date)) : undefined,
            description: `World Bank procurement — ${description}. Country: ${countryName}`,
            country: countryName,
            sector: n.notice_type ?? "Procurement",
            rawData: n as Record<string, unknown>,
          });
        }
      } catch {
        /* skip failed query */
      }

      // Stop after Caribbean pass if we have Bahamas results — avoid diluting with global noise
      if (label === "Caribbean" && results.some((r) => r.country === "Bahamas")) break;
    }

    return results;
  }
}
