import { TenderSourceAdapter, TenderOpportunity, AdapterFetchResult, safeFetch } from "./base-adapter.js";

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

// Communications/marketing-related keywords for filtering global notices
const COMMS_KEYWORDS = [
  "communications", "marketing", "campaign", "media", "branding",
  "outreach", "awareness", "public relations", "digital", "tourism",
  "promotional", "creative", "content", "engagement",
];

export class WorldBankAdapter implements TenderSourceAdapter {
  adapterType = "world_bank";

  async fetchOpportunities(): Promise<AdapterFetchResult> {
    // World Bank procnotices API: q param is not reliable for filtering.
    // Use fq (Solr filter query) with project_ctry_name for country targeting.
    // Fetch Bahamas-specific first, then Caribbean-wide comms work.
    const queries: Array<{ fq: string; label: string; filterComms: boolean }> = [
      // Bahamas-specific — highest priority
      { fq: "project_ctry_name:Bahamas", label: "Bahamas", filterComms: false },
      // Broader Caribbean
      {
        fq: `project_ctry_name:(${CARIBBEAN_COUNTRIES.map((c) => `"${c}"`).join(" OR ")})`,
        label: "Caribbean",
        filterComms: false,
      },
      // Global comms/marketing only — must contain a comms keyword
      { fq: "", label: "Global", filterComms: true },
    ];

    const seen = new Set<string>();
    const results: TenderOpportunity[] = [];
    const warnings: string[] = [];
    let requestsAttempted = 0;
    let requestsSucceeded = 0;

    for (const { fq, label, filterComms } of queries) {
      const base =
        `https://search.worldbank.org/api/v2/procnotices` +
        `?format=json&rows=20` +
        `&fl=id,project_id,project_name,bid_reference_no,bid_description,project_ctry_name,submission_date,notice_text,notice_type` +
        `&srt=submission_date&order=desc`;

      const url = fq ? `${base}&fq=${encodeURIComponent(fq)}` : base;
      requestsAttempted++;

      let r: Response;
      try {
        r = await safeFetch(url, {
          headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
        });
      } catch (err) {
        warnings.push(`World Bank ${label} query failed: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      if (!r.ok) {
        warnings.push(`World Bank ${label} query HTTP ${r.status}`);
        continue;
      }

      let data: { procnotices?: WBNotice[] };
      try {
        data = (await r.json()) as typeof data;
      } catch (err) {
        warnings.push(`World Bank ${label} JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      requestsSucceeded++;
      const notices = data?.procnotices ?? [];

      for (const n of notices) {
        const id = String(n.id ?? n.project_id ?? "");
        if (!id || seen.has(id)) continue;

        // For the global pass, only keep notices with comms-relevant content
        if (filterComms) {
          const noticeText = [n.bid_description, n.notice_text, n.project_name].join(" ").toLowerCase();
          if (!COMMS_KEYWORDS.some((kw) => noticeText.includes(kw))) continue;
        }

        seen.add(id);

        const countryName = String(n.project_ctry_name ?? label);
        const rawDesc = String(n.bid_description ?? n.notice_text ?? n.project_name ?? "").slice(0, 600);
        const projectId = String(n.project_id ?? "");
        const noticeId = String(n.id ?? "");

        // Use the actual bid_description / notice_text as the description — never prefix with "World Bank procurement —"
        // This preserves real scope content for the content-quality gate.
        const description = rawDesc.trim();

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
          description,
          country: countryName,
          sector: n.notice_type ?? "Procurement",
          rawData: n as Record<string, unknown>,
        });
      }

      // Stop after Caribbean pass if we have Bahamas results — avoid diluting with global noise
      if (label === "Caribbean" && results.some((r) => r.country === "Bahamas")) break;
    }

    // Throw if every request failed — caller records a failed source run
    if (requestsAttempted > 0 && requestsSucceeded === 0) {
      throw new Error(`World Bank API: all ${requestsAttempted} requests failed. ` + warnings.join("; "));
    }

    return { opportunities: results, requestsAttempted, requestsSucceeded, warnings };
  }
}
