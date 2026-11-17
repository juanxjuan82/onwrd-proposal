import { TenderSourceAdapter, TenderOpportunity } from "./base-adapter.js";

// UNDP Procurement Notices adapter.
// Uses procurement-notices.undp.org which has server-rendered HTML listings
// accessible without JS. Extracts surrounding table row context for each
// notice to produce descriptions that pass the eligibility content-quality gate.
export class UNGMAdapter implements TenderSourceAdapter {
  adapterType = "ungm";

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    throw new Error(
      "UNDP procurement notices are blocked because robots.txt disallows all paths. No requests were made.",
    );
  }
}
