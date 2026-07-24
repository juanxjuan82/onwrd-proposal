/**
 * Pure business-logic predicates for proposal lifecycle classification.
 * No framework dependencies — safe to import in Node.js tests.
 *
 * Source of truth: matches the predicate in proposal-generator/src/lib/proposal-predicates.ts.
 * Any contract change must be made in both files.
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
