import { Router } from "express";

const router = Router();

const SCOPES = [
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

function getCallbackUrl(): string {
  const domains = process.env.REPLIT_DOMAINS?.split(",").map((d) => d.trim()) ?? [];
  // Prefer the stable .replit.app domain over ephemeral riker/dev domains
  const preferred =
    domains.find((d) => d.endsWith(".replit.app")) ??
    process.env.REPLIT_DEV_DOMAIN ??
    domains[0];
  if (preferred) return `https://${preferred}/api/auth/google/callback`;
  return "http://localhost:3000/api/auth/google/callback";
}

router.get("/auth/google", (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    res.status(503).json({ error: "Google OAuth is not configured" });
    return;
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getCallbackUrl(),
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    state: (req.query.returnTo as string) || "/",
  });

  res.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
  );
});

router.get("/auth/google/callback", async (req, res) => {
  const { code, state, error } = req.query as Record<string, string>;
  const returnTo = state || "/";

  if (error || !code) {
    res.redirect(`${returnTo}?google_error=1`);
    return;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    res.redirect(`${returnTo}?google_error=1`);
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
      const err = await tokenRes.text();
      console.error("Token exchange failed:", err);
      res.redirect(`${returnTo}?google_error=1`);
      return;
    }

    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    const userinfoRes = await fetch(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      },
    );
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
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.redirect(`${returnTo}?google_error=1`);
  }
});

router.get("/auth/google/status", (req, res) => {
  const configured = !!(
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
  );
  const connected = !!req.session.googleAccessToken;
  const email = req.session.googleUserEmail ?? null;
  const callbackUrl = getCallbackUrl();
  res.json({ configured, connected, email, callbackUrl });
});

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
