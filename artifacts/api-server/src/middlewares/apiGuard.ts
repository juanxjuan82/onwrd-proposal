import { type NextFunction, type Request, type Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { getAuth, clerkClient } from "@clerk/express";
import { eq } from "drizzle-orm";
import { db, usersTable, type User } from "@workspace/db";
import { isAllowedEmail } from "../lib/allowed-domain.js";

declare global {
  namespace Express {
    interface Request {
      /** Local app-DB user row, resolved by requireAuth via the email bridge. */
      dbUser?: User;
    }
  }
}

/**
 * Deny-by-default authentication guard for the /api router.
 *
 * Every route requires an authenticated user EXCEPT the explicit public
 * allowlist below. New routes are therefore protected automatically.
 *
 * NOTE: paths here are relative to the /api mount point (no /api prefix).
 */
type PublicRule = { method: string; pattern: RegExp };

const PUBLIC_ROUTES: PublicRule[] = [
  // Health check (uptime probes)
  { method: "GET", pattern: /^\/healthz\/?$/ },
  // Google OAuth callback — Google redirects the browser here; the Drive
  // linkage itself is initiated from an authenticated page.
  { method: "GET", pattern: /^\/auth\/google\/callback\/?$/ },
  // Public prospect intake form
  { method: "POST", pattern: /^\/intake\/?$/ },
  { method: "POST", pattern: /^\/intake\/draft\/?$/ },
];

export function isPublicRoute(method: string, path: string): boolean {
  return PUBLIC_ROUTES.some(
    (r) => r.method === method && r.pattern.test(path),
  );
}

// Clerk's default session token does NOT include a custom `email` claim —
// that requires a custom JWT template, which this app has not configured.
// `auth.sessionClaims.email` is therefore unreliable (usually undefined) and
// MUST NOT be used for the domain check. `auth.userId` (Clerk's native ID)
// is always present and already cryptographically verified by
// clerkMiddleware, so we look the verified email up via the Clerk backend
// API instead. Cached briefly to avoid a Clerk API round-trip on every
// request.
type CachedEmail = { email: string | null; expiresAt: number };
const emailCache = new Map<string, CachedEmail>();
const EMAIL_CACHE_TTL_MS = 60_000;

type ClerkUserLookup = {
  emailAddresses: { id: string; emailAddress: string; verification: { status: string } | null }[];
  primaryEmailAddressId: string | null;
};

// Test-only seam so requireAuth's Clerk calls can be driven deterministically
// in auth-guard.test.ts (e.g. simulating an unverified/wrong-domain email or
// a second Clerk user reusing the same Express session) without hitting the
// real Clerk API. Both are null in production and unused unless a test
// explicitly opts in — mirrors the __setInvokeAISpy pattern in ai-gateway.ts.
export let __getAuthOverrideForTesting: ((req: Request) => { userId: string } | null) | null = null;
export let __getClerkUserOverrideForTesting: ((clerkUserId: string) => Promise<ClerkUserLookup>) | null = null;

export function __setGetAuthOverrideForTesting(
  fn: ((req: Request) => { userId: string } | null) | null,
): void {
  __getAuthOverrideForTesting = fn;
}

export function __setGetClerkUserOverrideForTesting(
  fn: ((clerkUserId: string) => Promise<ClerkUserLookup>) | null,
): void {
  __getClerkUserOverrideForTesting = fn;
  emailCache.clear();
}

async function resolveVerifiedEmail(clerkUserId: string): Promise<string | null> {
  const now = Date.now();
  const cached = emailCache.get(clerkUserId);
  if (cached && cached.expiresAt > now) return cached.email;

  const user = __getClerkUserOverrideForTesting
    ? await __getClerkUserOverrideForTesting(clerkUserId)
    : await clerkClient.users.getUser(clerkUserId);
  const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId);
  const email =
    primary && primary.verification?.status === "verified" ? primary.emailAddress : null;

  emailCache.set(clerkUserId, { email, expiresAt: now + EMAIL_CACHE_TTL_MS });
  return email;
}

/**
 * Resolves the local `users` row for a verified Clerk session, bridging by
 * email (the same column the pre-Clerk login flow used). JIT-provisions a
 * row on first sight — `onConflictDoNothing` handles concurrent first
 * requests racing to insert the same email.
 */
async function resolveDbUser(email: string): Promise<User> {
  const [existing] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);
  if (existing) return existing;

  const [inserted] = await db
    .insert(usersTable)
    .values({ email })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;

  // Lost the insert race — the row now exists from a concurrent request.
  const [dbUser] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email))
    .limit(1);
  if (!dbUser) throw new Error(`Failed to resolve or create user row for ${email}`);
  return dbUser;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  // The guard is disabled while running the test suite unless a test
  // explicitly opts in (AUTH_GUARD_TEST=1) — see auth-guard.test.ts, which
  // keeps the deny-by-default behavior under permanent regression coverage.
  if (
    process.env.NODE_ENV === "test" &&
    process.env.AUTH_GUARD_TEST !== "1"
  ) {
    next();
    return;
  }
  if (isPublicRoute(req.method, req.path)) {
    next();
    return;
  }

  const auth = __getAuthOverrideForTesting ? __getAuthOverrideForTesting(req) : getAuth(req);
  if (!auth?.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // Bridge column: email (same column the pre-Clerk Google Workspace login
  // used to resolve a session to a local user row). Resolved via the Clerk
  // backend API — see resolveVerifiedEmail for why sessionClaims.email
  // cannot be trusted here.
  let email: string | null;
  try {
    email = await resolveVerifiedEmail(auth.userId);
  } catch {
    res.status(502).json({ error: "Failed to verify account with identity provider" });
    return;
  }

  if (email === null || !isAllowedEmail(email)) {
    res.status(403).json({
      error: "Only @onwrdadvisors.com accounts can access this workspace.",
      code: "domain_not_allowed",
    });
    return;
  }

  // The Express session cookie (used for Google Drive OAuth tokens) is
  // independent of Clerk's own session cookie — signing out of Clerk does
  // NOT clear it. If a different Clerk user is now authenticating through
  // this same browser session (e.g. user A connects Drive, signs out, user
  // B signs in), wipe any Drive tokens left behind before they can be read
  // by any route, including this request.
  if (req.session.clerkUserId && req.session.clerkUserId !== auth.userId) {
    delete req.session.googleAccessToken;
    delete req.session.googleRefreshToken;
    delete req.session.googleTokenExpiry;
    delete req.session.googleUserEmail;
  }
  req.session.clerkUserId = auth.userId;

  try {
    req.dbUser = await resolveDbUser(email);
  } catch {
    res.status(500).json({ error: "Failed to resolve user account" });
    return;
  }
  next();
}

// ── Rate limiters ────────────────────────────────────────────────────────────

// Rate limiting is skipped while running the test suite unless a test
// explicitly opts in by setting RATE_LIMIT_TEST=1 (evaluated per request).
function skipInTests(): boolean {
  return process.env.NODE_ENV === "test" && process.env.RATE_LIMIT_TEST !== "1";
}

/** 5 intake submissions per IP per hour. */
export const intakeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  message: { error: "Too many intake submissions. Please try again later." },
});

/** 20 AI-invoking requests per session (fallback: IP) per hour. */
export const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  keyGenerator: (req) => req.dbUser?.id?.toString() ?? ipKeyGenerator(req.ip ?? ""),
  message: { error: "AI request limit reached. Please try again later." },
});

/** General API limiter: 300 requests per IP per 15 minutes. */
export const globalApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTests,
  message: { error: "Too many requests. Please slow down." },
});

/**
 * Route patterns (relative to /api) whose handlers call invokeAI.
 * Kept centralized so the AI limiter covers all of them.
 */
const AI_ROUTE_PATTERNS: RegExp[] = [
  /^\/proposals\/[^/]+\/run-critic\/?$/,
  /^\/proposals\/[^/]+\/ai-improve-sections\/?$/,
  /^\/proposals\/check-brief\/?$/,
  /^\/proposals\/parse-brief\/?$/,
  /^\/opportunities\/[^/]+\/analyze\/?$/,
  /^\/opportunities\/[^/]+\/resume-analysis\/?$/,
  /^\/opportunities\/[^/]+\/extract-requirements\/?$/,
  /^\/opportunities\/[^/]+\/generate-strategy\/?$/,
  /^\/opportunities\/[^/]+\/generate-proposal\/?$/,
  /^\/opportunities\/[^/]+\/run-full-generation\/?$/,
  /^\/opportunities\/[^/]+\/pursue\/?$/,
];

export function isAiRoute(path: string): boolean {
  return AI_ROUTE_PATTERNS.some((p) => p.test(path));
}

/** Applies the AI limiter only to AI-invoking routes. */
export function aiRouteLimiter(req: Request, res: Response, next: NextFunction) {
  if (req.method === "POST" && isAiRoute(req.path)) {
    aiLimiter(req, res, next);
    return;
  }
  next();
}
