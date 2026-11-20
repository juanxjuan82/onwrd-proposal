import { bahamasListingRejection } from "../crawlers/bahamas-gov.js";

export interface StaleCheckInput {
  adapterType: string | null;
  title: string;
  url: string | null;
  deadline: Date | string | null;
}

/**
 * Why a stored crawler discovery can no longer be bid on, or null when it is
 * still live. Used by the clear-stale-discoveries script.
 */
export function staleDiscoveryReason(item: StaleCheckInput, now = new Date()): string | null {
  const deadline = item.deadline ? new Date(item.deadline) : undefined;
  if (deadline && !Number.isNaN(deadline.getTime()) && deadline < now) return "expired";

  if (item.adapterType === "bahamas_gov") {
    // Same rules the Bahamas adapter now applies before storing a notice:
    // archive rows (old upload stamp, no due date), contract awards, job
    // posts, navigation links and links to other organisations' portals.
    if (!item.url) return "no_source_link";
    const uploaded = item.url.match(/-(20\d{2})(\d{2})(\d{2})\d{6}\.[a-z0-9]+(?:[?#]|$)/i);
    return bahamasListingRejection({
      url: item.url,
      title: item.title,
      category: "",
      dueDate: deadline && !Number.isNaN(deadline.getTime()) ? deadline : undefined,
      uploadedAt: uploaded
        ? new Date(Date.UTC(Number(uploaded[1]), Number(uploaded[2]) - 1, Number(uploaded[3])))
        : undefined,
    }, now);
  }
  return null;
}
