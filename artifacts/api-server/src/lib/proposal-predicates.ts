/**
 * Shared predicates for proposal-level immutability checks.
 *
 * Canonical Google Doc states (block all app-side mutations):
 *   - syncStatus = 'handoff_complete'
 *   - googleFileId set with any syncStatus other than pending_first_write or handoff_in_progress
 *
 * Allowed states (app may still mutate):
 *   - syncStatus = null  (never exported)
 *   - syncStatus = 'pending_first_write'  (export in-flight, not yet written)
 *   - syncStatus = 'handoff_in_progress'  (export in-flight, being written)
 */
export function googleDocCanonicalPayload(proposal: {
  syncStatus: string | null;
  googleFileId: string | null;
  googleDocUrl?: string | null;
}): { error: string; code: string; googleDocUrl?: string } | null {
  const isHandoffComplete = proposal.syncStatus === "handoff_complete";
  const isLegacyLinked =
    !!proposal.googleFileId &&
    proposal.syncStatus !== "pending_first_write" &&
    proposal.syncStatus !== "handoff_in_progress" &&
    !isHandoffComplete;

  if (!isHandoffComplete && !isLegacyLinked) return null;

  const googleDocUrl =
    proposal.googleDocUrl ??
    (proposal.googleFileId
      ? `https://docs.google.com/document/d/${proposal.googleFileId}/edit`
      : undefined);

  return {
    error: "google_doc_canonical",
    code:  "google_doc_canonical",
    ...(googleDocUrl ? { googleDocUrl } : {}),
  };
}

/**
 * Returns true when the proposal has been handed off to Google Docs and the
 * Google Doc is now the canonical source of truth for proposal content.
 *
 * Equivalent to `googleDocCanonicalPayload(proposal) !== null`.
 */
export function isTeamReview(proposal: {
  syncStatus?: string | null;
  googleFileId?: string | null;
  googleDocUrl?: string | null;
}): boolean {
  const isHandoffComplete = proposal.syncStatus === "handoff_complete";
  const isLegacyLinked =
    !!(proposal.googleFileId ?? proposal.googleDocUrl) &&
    proposal.syncStatus !== "pending_first_write" &&
    proposal.syncStatus !== "handoff_in_progress" &&
    !isHandoffComplete;
  return isHandoffComplete || isLegacyLinked;
}
