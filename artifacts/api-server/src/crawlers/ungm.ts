import { TenderOpportunity, TenderSourceAdapter } from "./base-adapter.js";

export class UNGMAdapter implements TenderSourceAdapter {
  adapterType = "ungm";

  async fetchOpportunities(): Promise<TenderOpportunity[]> {
    // procurement-notices.undp.org/robots.txt currently disallows all paths.
    // Keep this adapter fail-closed even when invoked directly or manually.
    throw new Error("UNDP procurement notices are disabled: robots.txt disallows all paths. Use an authorized feed or manual import.");
  }
}
