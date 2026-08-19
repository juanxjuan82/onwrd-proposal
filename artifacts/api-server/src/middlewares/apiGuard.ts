import { type NextFunction, type Request, type Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { getSessionId } from "../lib/auth";

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
  // App auth (Google Workspace OAuth) — must be reachable to log in at all
  { method: "GET", pattern: /^\/auth\/user\/?$/ },
  { method: "GET", pattern: /^\/login\/?$/ },
  { method: "GET", pattern: /^\/callback\/?$/ },
  { method: "GET", pattern: /^\/logout\/?$/ },
  { method: "POST", pattern: /^\/mobile-auth\/token-exchange\/?$/ },
  { method: "POST", pattern: /^\/mobile-auth\/logout\/?$/ },
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

export function requireAuth(req: Request, res: Response, next: NextFunction) {
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
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Unauthorized" });
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
  keyGenerator: (req) => getSessionId(req) ?? ipKeyGenerator(req.ip ?? ""),
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
