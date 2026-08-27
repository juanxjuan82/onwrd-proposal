/**
 * Company-domain allowlist for workspace access.
 *
 * This check is enforced server-side on every authenticated request (see
 * `middlewares/apiGuard.ts`) — it is intentionally NOT delegated to any
 * Clerk-side domain-restriction feature, so it applies uniformly regardless
 * of how a Clerk session was created.
 */
export const ALLOWED_EMAIL_DOMAIN = "onwrdadvisors.com";

export function isAllowedEmail(email: unknown): boolean {
  if (typeof email !== "string") return false;
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return false;
  const domain = trimmed.slice(at + 1);
  return domain === ALLOWED_EMAIL_DOMAIN;
}
