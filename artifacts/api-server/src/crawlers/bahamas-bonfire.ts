import { TenderSourceAdapter, TenderOpportunity, safeFetch } from "./base-adapter.js";

// Government of The Bahamas e-procurement portal (Bonfire). The portal's own
// public feed lists every open opportunity with its closing date and ministry.
// The individual opportunity pages sit behind a browser check, so only the
// headline information is available to a crawler — these land in the inbox for
// a human to open rather than being auto-promoted.
const PORTAL = "https://bahamas.bonfirehub.com";
const FEED_URL = `${PORTAL}/PublicPortal/getOpenPublicOpportunitiesSectionData`;

interface BonfireProject {
  ProjectID?: string;
  ReferenceID?: string;
  ProjectName?: string;
  DateClose?: string;
  DepartmentID?: string;
}

interface BonfireFeed {
  success?: number;
  payload?: {
    projects?: Record<string, BonfireProject>;
    departments?: Record<string, { DepartmentName?: string }>;
  };
}

export class BahamasBonfireAdapter implements TenderSourceAdapter {
  adapterType = "bahamas_bonfire";
  skipDetailFetch = true;

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    const r = await safeFetch(FEED_URL, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`Bahamas e-procurement portal answered HTTP ${r.status}`);

    const data = (await r.json()) as BonfireFeed;
    if (!data?.payload?.projects) {
      throw new Error("Bahamas e-procurement portal returned an unexpected response");
    }

    const departments = data.payload.departments ?? {};
    const results: TenderOpportunity[] = [];

    for (const p of Object.values(data.payload.projects)) {
      const id = String(p.ProjectID ?? "");
      const title = String(p.ProjectName ?? "").trim();
      if (!id || title.length < 4) continue;

      const department = departments[String(p.DepartmentID ?? "")]?.DepartmentName?.trim();
      // DateClose is "YYYY-MM-DD HH:mm:ss" (UTC)
      const deadline = p.DateClose ? new Date(`${p.DateClose.replace(" ", "T")}Z`) : undefined;

      results.push({
        externalId: `bonfire-bs-${id}`,
        title,
        organization: department
          ? `Government of The Bahamas — ${department}`
          : "Government of The Bahamas",
        url: `${PORTAL}/opportunities/${id}`,
        deadline: deadline && !isNaN(deadline.getTime()) ? deadline : undefined,
        // Headline only — the portal does not expose the scope text to crawlers,
        // so this is deliberately short and will not be auto-promoted.
        description: `Bahamas e-procurement opportunity: ${title}`,
        country: "Bahamas",
        sector: "Government Procurement",
        rawData: { ...p, department } as Record<string, unknown>,
      });
    }

    return results;
  }
}
