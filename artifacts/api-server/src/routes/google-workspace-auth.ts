import {
  ExchangeMobileAuthorizationCodeBody,
  ExchangeMobileAuthorizationCodeResponse,
  GetCurrentAuthUserResponse,
  LogoutMobileSessionResponse,
} from "@workspace/api-zod";
import crypto from "crypto";
import { Router, type IRouter, type Request, type Response } from "express";

import {
  clearSession,
  createSession,
  deleteSession,
  getSessionId,
  isAllowedEmail,
  setSessionCookie,
  type SessionData,
  upsertUser,
} from "../lib/auth.js";
import {
  buildGoogleLoginUrl,
  createGoogleState,
  exchangeGoogleCode,
  getGoogleUserInfo,
  type GoogleTokens,
} from "../lib/google-oauth.js";

const router: IRouter = Router();

export function getSafeReturnTo(value: unknown): string {
  if (typeof value !== "string") return "/";
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return "/";
  }

  if (
    !decoded.startsWith("/") ||
    decoded.startsWith("//") ||
    decoded.includes("\\") ||
    /[\x00-\x1f\x7f]/.test(decoded) ||
    /^\/[a-z][a-z0-9+\-.]*:/i.test(decoded)
  ) {
    return "/";
  }
  return decoded;
}

function stateMatches(expected: string | undefined, received: unknown): boolean {
  if (!expected || typeof received !== "string") return false;
  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(received, "utf8");
  return (
    expectedBuffer.length === receivedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

function redirectWithError(res: Response, returnTo: string, error: string): void {
  const separator = returnTo.includes("?") ? "&" : "?";
  res.redirect(`${returnTo}${separator}google_error=${encodeURIComponent(error)}`);
}

export async function createGoogleWorkspaceSession(
  res: Response,
  tokens: GoogleTokens,
): Promise<{ status: "created"; sid: string } | { status: "not_allowed" }> {
  const profile = await getGoogleUserInfo(tokens.access_token);
  const isVerified =
    profile.email_verified === true || profile.verified_email === true;

  if (!profile.sub || !isVerified || !isAllowedEmail(profile.email)) {
    return { status: "not_allowed" };
  }

  const dbUser = await upsertUser(profile as Record<string, unknown>);
  const now = Math.floor(Date.now() / 1000);
  const sessionData: SessionData = {
    provider: "google",
    user: {
      id: dbUser.id,
      email: dbUser.email,
      firstName: dbUser.firstName,
      lastName: dbUser.lastName,
      profileImageUrl: dbUser.profileImageUrl,
    },
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    // The access token is only used for an optional refresh, never for
    // authorization. A local session remains valid for its own seven-day TTL.
    expires_at: tokens.refresh_token && tokens.expires_in
      ? now + tokens.expires_in
      : undefined,
  };

  const sid = await createSession(sessionData);
  setSessionCookie(res, sid);
  return { status: "created", sid };
}

router.get("/auth/user", (req: Request, res: Response) => {
  res.json(
    GetCurrentAuthUserResponse.parse({
      user: req.isAuthenticated() ? req.user : null,
    }),
  );
});

router.get("/login", (req: Request, res: Response) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    res.status(503).json({ error: "Google Workspace login is not configured" });
    return;
  }

  const state = createGoogleState();
  req.session.googleLoginState = state;
  req.session.googleLoginReturnTo = getSafeReturnTo(req.query.returnTo);

  req.session.save((err) => {
    if (err) {
      res.status(503).json({ error: "Session store unavailable" });
      return;
    }
    res.redirect(buildGoogleLoginUrl(state));
  });
});

// Google returns to the existing /auth/google/callback route, which handles
// both login and Drive connection callbacks. This legacy route simply makes
// stale Replit redirect URIs harmless.
router.get("/callback", (_req: Request, res: Response) => {
  res.redirect("/api/login");
});

router.get("/logout", async (req: Request, res: Response) => {
  const returnTo = getSafeReturnTo(req.query.returnTo);
  const sid = getSessionId(req);
  await clearSession(res, sid);

  req.session.destroy(() => {
    res.redirect(returnTo);
  });
});

router.post(
  "/mobile-auth/token-exchange",
  async (req: Request, res: Response) => {
    const parsed = ExchangeMobileAuthorizationCodeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Missing or invalid required parameters" });
      return;
    }

    const { code, code_verifier, redirect_uri } = parsed.data;
    try {
      const tokens = await exchangeGoogleCode(code, redirect_uri, code_verifier);
      const result = await createGoogleWorkspaceSession(res, tokens);
      if (result.status === "not_allowed") {
        res.status(403).json({
          error: "Only @onwrdadvisors.com accounts can access this workspace.",
          code: "email_domain_not_allowed",
        });
        return;
      }

      res.json(ExchangeMobileAuthorizationCodeResponse.parse({ token: result.sid }));
    } catch {
      res.status(401).json({ error: "Google sign-in could not be completed" });
    }
  },
);

router.post("/mobile-auth/logout", async (req: Request, res: Response) => {
  const sid = getSessionId(req);
  if (sid) await deleteSession(sid);
  res.json(LogoutMobileSessionResponse.parse({ success: true }));
});

export { stateMatches, redirectWithError };
export default router;