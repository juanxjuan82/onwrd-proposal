import { TenderSourceAdapter, TenderOpportunity, safeFetch } from "./base-adapter.js";

interface WBNotice {
  id?: string;
  project_id?: string;
  project_name?: string;
  submission_date?: string;
  sector?: Array<{ sector_code?: string; sector_description?: string }> | string;
  [key: string]: unknown;
}

export class WorldBankAdapter implements TenderSourceAdapter {
  adapterType = "world_bank";

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    const queries = [
      "communications marketing media campaign",
      "tourism promotion branding",
      "community engagement stakeholder awareness",
    ];
    const seen = new Set<string>();
    const results: TenderOpportunity[] = [];

    for (const q of queries) {
      try {
        const url =
          `https://search.worldbank.org/api/v2/procnotices` +
          `?format=json&rows=20` +
          `&fl=id,project_id,project_name,submission_date,sector,country_code,country_name` +
          `&srt=submission_date&order=desc` +
          `&q=${encodeURIComponent(q)}`;

        const r = await safeFetch(url, {
          headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
        });
        if (!r.ok) continue;

        const data = (await r.json()) as { procnotices?: WBNotice[] };
        const notices = data?.procnotices ?? [];

        for (const n of notices) {
          const id = String(n.id ?? n.project_id ?? "");
          if (!id || seen.has(id)) continue;
          seen.add(id);

          const sectors = Array.isArray(n.sector)
            ? n.sector.map((s) => s.sector_description ?? "").filter(Boolean).join(", ")
            : String(n.sector ?? "");

          const projectId = String(n.project_id ?? "");
          const noticeId = String(n.id ?? "");

          results.push({
            externalId: `wb-${noticeId || projectId}`,
            title: String(n.project_name ?? "World Bank Procurement Notice"),
            organization: "World Bank",
            url: noticeId
              ? `https://projects.worldbank.org/en/projects-operations/procurement/noticedetails?id=${noticeId}`
              : projectId
              ? `https://projects.worldbank.org/en/projects-operations/project-detail/${projectId}`
              : "https://projects.worldbank.org/en/projects-operations/procurement",
            deadline: n.submission_date ? new Date(String(n.submission_date)) : undefined,
            description: `World Bank procurement — ${String(n.project_name ?? "")}. Sector: ${sectors || "General"}`,
            country: String((n as Record<string, unknown>).country_name ?? ""),
            sector: sectors,
            rawData: n as Record<string, unknown>,
          });
        }
      } catch {
        /* skip failed query */
      }
    }

    return results;
  }
}
