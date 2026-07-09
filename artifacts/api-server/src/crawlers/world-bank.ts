import { TenderSourceAdapter, TenderOpportunity, safeFetch } from "./base-adapter.js";

interface WBNotice {
  id?: string;
  project_id?: string;
  project_name?: string;
  submission_date?: string;
  sector?: Array<{ sector_code?: string; sector_description?: string }> | string;
  country_name?: string;
  country_code?: string;
  [key: string]: unknown;
}

// Caribbean/SIDS country codes for World Bank regional filtering
const CARIBBEAN_CODES = "BS,JM,BB,GY,LC,VC,TT,DM,KN,GD,AG,BZ,HT,DO,TC,KY,BM,VG,VI,PR,CU,SX,MF,AW,CW";

export class WorldBankAdapter implements TenderSourceAdapter {
  adapterType = "world_bank";

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    const queryGroups = [
      // Caribbean-targeted comms queries
      {
        q: "communications marketing campaign branding",
        extra: `&countrycode_exact=${CARIBBEAN_CODES}`,
      },
      {
        q: "tourism promotion destination marketing",
        extra: `&countrycode_exact=${CARIBBEAN_CODES}`,
      },
      {
        q: "community engagement public awareness stakeholder",
        extra: `&countrycode_exact=${CARIBBEAN_CODES}`,
      },
      // Global comms queries (no region filter — high-value global comms work)
      { q: "communications marketing media campaign branding", extra: "" },
      { q: "tourism promotion destination marketing campaign", extra: "" },
      { q: "community engagement stakeholder public awareness campaign", extra: "" },
    ];

    const seen = new Set<string>();
    const results: TenderOpportunity[] = [];

    for (const { q, extra } of queryGroups) {
      try {
        const url =
          `https://search.worldbank.org/api/v2/procnotices` +
          `?format=json&rows=15` +
          `&fl=id,project_id,project_name,submission_date,sector,country_code,country_name` +
          `&srt=submission_date&order=desc` +
          `&q=${encodeURIComponent(q)}${extra}`;

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

          const countryName = String(n.country_name ?? "");
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
            description: `World Bank procurement — ${String(n.project_name ?? "")}. Sector: ${sectors || "General"}. Country: ${countryName}`,
            country: countryName,
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
