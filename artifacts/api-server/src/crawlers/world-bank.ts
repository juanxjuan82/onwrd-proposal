import { TenderSourceAdapter, TenderOpportunity, safeFetch } from "./base-adapter.js";

interface WBNotice {
  id?: string;
  project_name?: string;
  borrower?: string;
  notice_type?: string;
  submission_date?: string;
  contact_email?: string;
  url?: string;
  project_id?: string;
  description?: string;
  country_name?: string;
  sector?: string;
  [key: string]: unknown;
}

export class WorldBankAdapter implements TenderSourceAdapter {
  adapterType = "world_bank";

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    const queries = ["communications marketing", "media campaign", "tourism promotion"];
    const seen = new Set<string>();
    const results: TenderOpportunity[] = [];

    for (const q of queries) {
      try {
        const url = `https://search.worldbank.org/api/v2/procurement?format=json&fl=id,project_name,borrower,notice_type,submission_date,url,project_id,country_name,sector&rows=15&q=${encodeURIComponent(q)}`;
        const r = await safeFetch(url);
        if (!r.ok) continue;
        const data = await r.json() as { procnotices?: { ProcNotice?: WBNotice[] } };
        const notices = data?.procnotices?.ProcNotice ?? [];

        for (const n of notices) {
          const id = String(n.id ?? n.project_id ?? "");
          if (!id || seen.has(id)) continue;
          seen.add(id);

          results.push({
            externalId: `wb-${id}`,
            title: String(n.project_name ?? "World Bank Procurement"),
            organization: String(n.borrower ?? "World Bank"),
            url: n.url ? String(n.url) : `https://projects.worldbank.org/en/projects-operations/procurement`,
            deadline: n.submission_date ? new Date(String(n.submission_date)) : undefined,
            description: `${n.notice_type ?? "Procurement notice"} — ${n.country_name ?? ""}. Project: ${n.project_name ?? ""}`,
            country: String(n.country_name ?? ""),
            sector: String(n.sector ?? ""),
            rawData: n as Record<string, unknown>,
          });
        }
      } catch { /* skip this query */ }
    }

    return results;
  }
}
