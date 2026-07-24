/**
 * Pure business-logic predicates for proposal lifecycle classification.
 * No React dependencies — safe to import in Node.js tests and browser alike.
 */

export interface ProposalPredicateInput {
  syncStatus?: string | null;
  googleDocUrl?: string | null;
  googleFileId?: string | null;
}

/**
 * Returns true when the proposal has reached the Team Review stage:
 *   • syncStatus === 'handoff_complete', OR
 *   • a Google Doc URL/file-ID is present AND the sync is not still in-flight.
 */
export function isTeamReview(p: ProposalPredicateInput): boolean {
  if (p.syncStatus === "handoff_complete") return true;
  return !!(
    (p.googleDocUrl || p.googleFileId) &&
    p.syncStatus !== "pending_first_write" &&
    p.syncStatus !== "handoff_in_progress"
  );
}
