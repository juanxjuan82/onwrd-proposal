import type { Session, SessionData } from "express-session";

export class GoogleAuthError extends Error {
  readonly statusCode = 401;
  readonly reason: "not_connected" | "not_configured" | "token_expired" | "refresh_failed";

  constructor(reason: GoogleAuthError["reason"]) {
    super(`Google auth: ${reason}`);
    this.name = "GoogleAuthError";
    this.reason = reason;
  }
}

function clearGoogleSession(session: Session & Partial<SessionData>): void {
  delete session.googleAccessToken;
  delete session.googleRefreshToken;
  delete session.googleTokenExpiry;
  delete session.googleUserEmail;
}

/**
 * Returns a valid Google access token from the session, proactively refreshing
 * when within 60 seconds of expiry. Mutates the session in-place.
 *
 * Throws GoogleAuthError("not_connected")   — no access token present
 * Throws GoogleAuthError("not_configured")  — missing env vars
 * Throws GoogleAuthError("token_expired")   — expired, no refresh token; session cleared
 * Throws GoogleAuthError("refresh_failed")  — refresh call failed; session cleared
 */
export async function getValidGoogleAccessToken(
  session: Session & Partial<SessionData>,
): Promise<string> {
  if (!session.googleAccessToken) {
    throw new GoogleAuthError("not_connected");
  }

  const expiry = session.googleTokenExpiry ?? 0;
  if (Date.now() < expiry - 60_000) {
    return session.googleAccessToken;
  }

  if (!session.googleRefreshToken) {
    clearGoogleSession(session);
    throw new GoogleAuthError("token_expired");
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new GoogleAuthError("not_configured");
  }

  let res: Response;
  try {
    res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: session.googleRefreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    });
  } catch {
    clearGoogleSession(session);
    throw new GoogleAuthError("refresh_failed");
  }

  if (!res.ok) {
    clearGoogleSession(session);
    throw new GoogleAuthError("refresh_failed");
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  session.googleAccessToken = data.access_token;
  session.googleTokenExpiry = Date.now() + data.expires_in * 1000;

  return data.access_token;
}
