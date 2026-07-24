import { Router } from "express";
import crypto from "crypto";
import { getValidGoogleAccessToken, GoogleAuthError } from "../lib/google-auth.js";
import { logger } from "../lib/logger.js";

const router = Router();

const SCOPES = [
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

function getCallbackUrl(): string {
  const domains = process.env.REPLIT_DOMAINS?.split(",").map((d) => d.trim()) ?? [];
  const preferred =
    domains.find((d) => d.endsWith(".replit.app")) ??
    process.env.REPLIT_DEV_DOMAIN ??
    domains[0];
  if (preferred) return `https://${preferred}/api/auth/google/callback`;
  return "http://localhost:3000/api/auth/google/callback";
}

/**
 * Sanitise a returnTo path. Must begin with exactly one "/" and contain no
 * "//" prefix, backslashes, control characters, or embedded absolute URLs.
 * Returns "/" for any invalid input.
 */
function sanitiseReturnTo(raw: string | undefined): string {
  if (!raw) return "/";
  try {
    const decoded = decodeURIComponent(raw);
    if (
      !decoded.startsWith("/") ||
      decoded.startsWith("//") ||
      decoded.includes("\\") ||
      /[\x00-\x1f]/.test(decoded) ||
      /^\/[a-z][a-z0-9+\-.]*:/i.test(decoded)
    ) {
      return "/";
    }
    return decoded;
  } catch {
    return "/";
  }
}

// ── Initiate OAuth ──────────────────────────────────────────────────────────
router.get("/auth/google", (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    res.status(503).json({ error: "Google OAuth is not configured" });
    return;
  }

  const returnTo = sanitiseReturnTo(req.query.returnTo as string | undefined);
  const state = crypto.randomBytes(32).toString("hex");

  req.session.googleOAuthState = state;
  req.session.googleOAuthReturnTo = returnTo;

  req.session.save((err) => {
    if (err) {
      logger.error({ err }, "session save failed");
      res.status(500).json({ error: "Session error" });
      return;
    }

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: getCallbackUrl(),
      response_type: "code",
      scope: SCOPES,
      access_type: "offline",
      prompt: "consent",
      state,
    });

    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  });
});

// ── OAuth callback ──────────────────────────────────────────────────────────
router.get("/auth/google/callback", async (req, res) => {
  const { code, state, error } = req.query as Record<string, string>;

  // Read and immediately delete state — single use, reject replays
  const savedState = req.session.googleOAuthState;
  const returnTo = sanitiseReturnTo(req.session.googleOAuthReturnTo);
  delete req.session.googleOAuthState;
  delete req.session.googleOAuthReturnTo;

  if (error || !code) {
    req.session.save(() => res.redirect(`${returnTo}?google_error=1`));
    return;
  }

  // Timing-safe state comparison
  if (!savedState || !state) {
    req.session.save(() => res.redirect(`${returnTo}?google_error=1`));
    return;
  }
  try {
    const savedBuf = Buffer.from(savedState, "utf8");
    const receivedBuf = Buffer.from(state, "utf8");
    if (
      savedBuf.length !== receivedBuf.length ||
      !crypto.timingSafeEqual(savedBuf, receivedBuf)
    ) {
      req.session.save(() => res.redirect(`${returnTo}?google_error=1`));
      return;
    }
  } catch {
    req.session.save(() => res.redirect(`${returnTo}?google_error=1`));
    return;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    req.session.save(() => res.redirect(`${returnTo}?google_error=1`));
    return;
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: getCallbackUrl(),
        grant_type: "authorization_code",
      }).toString(),
    });

    if (!tokenRes.ok) {
      req.session.save(() => res.redirect(`${returnTo}?google_error=1`));
      return;
    }

    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    const userinfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const userinfo = userinfoRes.ok
      ? ((await userinfoRes.json()) as { email?: string })
      : {};

    req.session.googleAccessToken = tokens.access_token;
    if (tokens.refresh_token) {
      req.session.googleRefreshToken = tokens.refresh_token;
    }
    req.session.googleTokenExpiry = Date.now() + tokens.expires_in * 1000;
    req.session.googleUserEmail = userinfo.email ?? undefined;

    req.session.save(() => {
      res.redirect(`${returnTo}?google_connected=1`);
    });
  } catch {
    req.session.save(() => res.redirect(`${returnTo}?google_error=1`));
  }
});

// ── Connection status ───────────────────────────────────────────────────────
router.get("/auth/google/status", async (req, res) => {
  const configured = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const callbackUrl = getCallbackUrl();

  if (!req.session.googleAccessToken) {
    res.json({ configured, connected: false, email: null, callbackUrl });
    return;
  }

  try {
    const token = await getValidGoogleAccessToken(req.session);

    // Verify token hasn't been revoked by calling userinfo
    const userinfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!userinfoRes.ok) {
      delete req.session.googleAccessToken;
      delete req.session.googleRefreshToken;
      delete req.session.googleTokenExpiry;
      delete req.session.googleUserEmail;
      await new Promise<void>((resolve) => req.session.save(() => resolve()));
      res.json({ configured, connected: false, email: null, callbackUrl, reason: "token_expired" });
      return;
    }

    const userinfo = (await userinfoRes.json()) as { email?: string };
    const email = userinfo.email ?? req.session.googleUserEmail ?? null;
    if (email) req.session.googleUserEmail = email;

    await new Promise<void>((resolve) => req.session.save(() => resolve()));
    res.json({ configured, connected: true, email, callbackUrl });
  } catch (err) {
    const reason = err instanceof GoogleAuthError ? "token_expired" : "token_expired";
    res.json({ configured, connected: false, email: null, callbackUrl, reason });
  }
});

// ── Picker token ────────────────────────────────────────────────────────────
router.get("/auth/google/picker-token", async (req, res) => {
  try {
    const token = await getValidGoogleAccessToken(req.session);
    await new Promise<void>((resolve) => req.session.save(() => resolve()));
    res.json({ accessToken: token });
  } catch (err) {
    if (err instanceof GoogleAuthError) {
      res.status(401).json({ error: "Google account not connected", reason: err.reason });
      return;
    }
    res.status(500).json({ error: "Failed to retrieve access token" });
  }
});

// ── Disconnect ──────────────────────────────────────────────────────────────
router.post("/auth/google/disconnect", (req, res) => {
  delete req.session.googleAccessToken;
  delete req.session.googleRefreshToken;
  delete req.session.googleTokenExpiry;
  delete req.session.googleUserEmail;
  req.session.save(() => {
    res.json({ success: true });
  });
});

export default router;
