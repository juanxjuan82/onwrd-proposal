import crypto from "crypto";

export const GOOGLE_LOGIN_SCOPES = "openid email profile";

export interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  id_token?: string;
}

export interface GoogleUserInfo {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  verified_email?: boolean;
  given_name?: string;
  family_name?: string;
  picture?: string;
}

export function getGoogleCallbackUrl(): string {
  if (process.env.GOOGLE_OAUTH_CALLBACK_URL) {
    return process.env.GOOGLE_OAUTH_CALLBACK_URL;
  }

  const domains = process.env.REPLIT_DOMAINS?.split(",").map((d) => d.trim()) ?? [];
  const preferred =
    domains.find((d) => d.endsWith(".replit.app")) ??
    process.env.REPLIT_DEV_DOMAIN ??
    domains[0];

  if (preferred) return `https://${preferred}/api/auth/google/callback`;
  return "http://localhost:3000/api/auth/google/callback";
}

export function createGoogleState(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function buildGoogleLoginUrl(state: string): string {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error("GOOGLE_CLIENT_ID is not configured");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getGoogleCallbackUrl(),
    response_type: "code",
    scope: GOOGLE_LOGIN_SCOPES,
    access_type: "offline",
    prompt: "select_account",
    hd: "onwrdadvisors.com",
    state,
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeGoogleCode(
  code: string,
  redirectUri: string,
  codeVerifier?: string,
): Promise<GoogleTokens> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth is not configured");
  }

  const body: Record<string, string> = {
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  };
  if (codeVerifier) body.code_verifier = codeVerifier;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });

  if (!tokenRes.ok) {
    throw new Error("Google authorization code exchange failed");
  }

  return (await tokenRes.json()) as GoogleTokens;
}

export async function getGoogleUserInfo(
  accessToken: string,
): Promise<GoogleUserInfo> {
  const userinfoRes = await fetch(
    "https://openidconnect.googleapis.com/v1/userinfo",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!userinfoRes.ok) {
    throw new Error("Google userinfo request failed");
  }

  return (await userinfoRes.json()) as GoogleUserInfo;
}