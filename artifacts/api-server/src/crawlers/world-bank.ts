import { TenderSourceAdapter, TenderOpportunity, safeFetch } from "./base-adapter.js";

// World Bank Procurement Notices adapter.
//
// API: https://search.worldbank.org/api/v2/procnotices
//
// Key design decisions (Jul 2026):
//  • submission_deadline_date is the ACTUAL bid deadline.
//    submission_date is the notice PUBLICATION date — using it as the deadline
//    caused all 184 stored items to appear expired (published = yesterday).
//  • The fq (Solr filter) for project_ctry_name is silently ignored by the API
//    endpoint — all fq values return the full 412k+ dataset regardless. Country
//    targeting is done via the q (full-text search) parameter instead.
//  • Items with a past submission_deadline_date are filtered out client-side so
//    the eligibility gate never sees expired notices.
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
  [key: string]: unknown;
}

export class WorldBankAdapter implements TenderSourceAdapter {
  adapterType = "world_bank";

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    // Use q (full-text search) for targeting — the fq filter is non-functional.
    // Three passes: Caribbean comms focus, broader Caribbean, global comms-only.
    const queries: Array<{ q: string; label: string }> = [
      {
        q: "communications marketing Caribbean Bahamas Jamaica Barbados",
        label: "Caribbean comms",
      },
      {
        q: "campaign media branding outreach awareness CARICOM OECS Caribbean",
        label: "Caribbean media",
      },
      {
        q: "communications marketing digital campaign media",
        label: "Global comms",
      },
    ];

    const seen = new Set<string>();
    const results: TenderOpportunity[] = [];
    const warnings: string[] = [];
    let requestsAttempted = 0;
    let requestsSucceeded = 0;
    const now = new Date();

    for (const { q, label } of queries) {
      const url =
        `https://search.worldbank.org/api/v2/procnotices` +
        `?format=json&rows=25` +
        `&fl=id,project_id,project_name,bid_description,project_ctry_name,` +
        `submission_date,submission_deadline_date,notice_text,notice_type` +
        `&q=${encodeURIComponent(q)}` +
        `&srt=noticedate&order=desc`;

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

        // submission_deadline_date is the actual bid deadline.
        // Fall back to submission_date only if the deadline field is absent.
        const deadlineStr = String(n.submission_deadline_date ?? n.submission_date ?? "").trim();
        const deadline = deadlineStr ? new Date(deadlineStr) : undefined;

        // Skip notices with an expired deadline.
        if (deadline && deadline <= now) continue;

        seen.add(id);

        const countryName = String(n.project_ctry_name ?? "");
        const rawDesc = String(n.bid_description ?? n.notice_text ?? n.project_name ?? "").slice(0, 600);
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
          deadline,
          description: rawDesc.trim(),
          country: countryName,
          sector: n.notice_type ?? "Procurement",
          rawData: n as Record<string, unknown>,
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
