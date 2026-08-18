/**
 * Task #62 — Deny-by-default authentication guard + rate limiting
 *
 * Runner: node:test + tsx  (node --import tsx/esm --test this-file.ts)
 *
 * Covers:
 *   §1  Standing route-enumeration test: every mounted /api route rejects
 *       unauthenticated requests with 401 UNLESS explicitly allowlisted.
 *       This is a permanent regression guard — any new route added without
 *       auth consideration fails here.
 *   §2  Public intake endpoints stay reachable without auth.
 *   §3  Auth endpoints are reachable without auth.
 *   §4  Rate limiting: intake burst returns 429 after the limit.
 *   §5  AI-route pattern coverage (every invokeAI-calling route is matched).
 */
process.env.NODE_ENV = "test";
process.env.AUTH_GUARD_TEST = "1"; // keep the deny-by-default guard ACTIVE in this suite

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Server } from "node:http";
import crypto from "node:crypto";

import app, { dbReady } from "../app.js";
import router from "./index.js";
import { isPublicRoute, isAiRoute } from "../middlewares/apiGuard.js";
import { getSafeReturnTo, getOrigin } from "./replit-auth.js";
import { pool } from "@workspace/db";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Enumerate every route mounted on the /api router ─────────────────────────
interface RouteInfo {
  method: string;
  path: string; // relative to /api, params substituted
}

function substituteParams(p: string): string {
  return p.replace(/:[A-Za-z0-9_]+/g, "1");
}

function collectRoutes(): RouteInfo[] {
  const out: RouteInfo[] = [];
  // Express 5 router internals: router.stack entries with .route
  type Layer = {
    route?: { path: string; methods: Record<string, boolean> };
    name?: string;
    handle?: { stack?: Layer[] };
    // Express 5 keeps mount path info differently; nested routers here are
    // all mounted at "/" except /admin.
    path?: string;
  };
  const stack = (router as unknown as { stack: Layer[] }).stack;

  function walk(layers: Layer[], prefix: string) {
    for (const layer of layers) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods)) {
          out.push({
            method: m.toUpperCase(),
            path: prefix + substituteParams(layer.route.path),
          });
        }
      } else if (layer.handle?.stack) {
        // Nested router. The only prefixed mount is /admin.
        const nestedPrefix =
          layer.path ?? ((layer as { regexp?: RegExp }).regexp?.source.includes("admin") ? "/admin" : "");
        walk(layer.handle.stack, prefix + (nestedPrefix === "/" ? "" : nestedPrefix));
      }
    }
  }
  walk(stack, "");
  return out;
}

// ── HTTP helper against a live server instance ───────────────────────────────
let server: Server;
let baseUrl: string;

async function req(
  method: string,
  p: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${baseUrl}/api${p}`, {
    method,
    redirect: "manual",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("auth guard (task #62)", () => {
  before(async () => {
    await dbReady;
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (addr == null || typeof addr === "string") throw new Error("no port");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end().catch(() => {});
  });

  // §1 Standing route-enumeration regression guard
  describe("§1 route enumeration — deny by default", () => {
    it("every non-allowlisted route returns 401 when unauthenticated", async () => {
      const routes = collectRoutes();
      assert.ok(routes.length > 30, `expected many routes, got ${routes.length}`);

      const failures: string[] = [];
      for (const r of routes) {
        if (isPublicRoute(r.method, r.path)) continue;
        const res = await req(r.method, r.path);
        if (res.status !== 401) {
          failures.push(`${r.method} ${r.path} → ${res.status} (expected 401)`);
        }
      }
      assert.deepEqual(
        failures,
        [],
        `Unauthenticated requests must get 401:\n${failures.join("\n")}`,
      );
    });

    it("the public allowlist is small and explicit", () => {
      // Guard against accidental allowlist growth. Update deliberately.
      const publicCount = collectRoutes().filter((r) =>
        isPublicRoute(r.method, r.path),
      ).length;
      assert.ok(
        publicCount <= 12,
        `public allowlist grew unexpectedly: ${publicCount} routes`,
      );
    });
  });

  // §2 Public intake endpoints
  describe("§2 intake stays public", () => {
    it("POST /intake/draft works without auth", async () => {
      const key = crypto.randomUUID();
      const res = await req("POST", "/intake/draft", {
        submissionKey: key,
        firstName: "T",
        lastName: "T",
        jobTitle: "T",
        email: "authguard-test@example.com",
      });
      assert.ok(
        res.status < 500 && res.status !== 401 && res.status !== 403,
        `intake draft must not require auth (got ${res.status})`,
      );
      await pool.query(`DELETE FROM intake_drafts WHERE submission_key = $1`, [key]);
    });

    it("POST /intake is reachable without auth (may 400 on bad body, never 401)", async () => {
      const res = await req("POST", "/intake", {});
      assert.notEqual(res.status, 401);
      assert.notEqual(res.status, 403);
    });
  });

  // §3 Auth endpoints
  describe("§3 auth endpoints are public", () => {
    it("GET /auth/user returns {user:null} when unauthenticated", async () => {
      const res = await req("GET", "/auth/user");
      assert.equal(res.status, 200);
      const body = (await res.json()) as { user: unknown };
      assert.equal(body.user, null);
    });

    it("GET /login redirects to the OIDC provider", async () => {
      const res = await req("GET", "/login");
      assert.equal(res.status, 302);
    });
  });

  // §4 Rate limiting burst
  describe("§4 rate limiting", () => {
    it("intake POST bursts beyond the limit return 429", async () => {
      process.env.RATE_LIMIT_TEST = "1";
      try {
        let got429 = false;
        for (let i = 0; i < 7; i++) {
          const res = await req("POST", "/intake", {});
          if (res.status === 429) {
            got429 = true;
            break;
          }
        }
        assert.ok(got429, "expected a 429 within 7 rapid intake submissions");
      } finally {
        delete process.env.RATE_LIMIT_TEST;
      }
    });
  });

  // §4b returnTo sanitization — open-redirect regression guard
  describe("§4b returnTo sanitization", () => {
    it("rejects external/scheme-relative/malformed targets", () => {
      for (const bad of [
        "//evil.example",
        "/\\evil.example",
        "\\evil.example",
        "/%5Cevil.example", // encoded backslash
        "/foo\\bar",
        "/javascript:alert(1)",
        "/\x00",
        "%2F%2Fevil.example", // encoded //
        "https://evil.example",
        "javascript:alert(1)",
        123,
        null,
        "%ZZ", // malformed encoding
      ]) {
        assert.equal(getSafeReturnTo(bad), "/", `must reject: ${String(bad)}`);
      }
    });

    it("accepts plain same-origin paths", () => {
      assert.equal(getSafeReturnTo("/proposal-generator"), "/proposal-generator");
      assert.equal(getSafeReturnTo("/proposals?tab=all"), "/proposals?tab=all");
    });
  });

  // §4c CORS — credentialed responses must not reflect arbitrary origins
  describe("§4c CORS origin allowlist", () => {
    it("hostile Origin gets no Access-Control-Allow-Origin header", async () => {
      const res = await fetch(`${baseUrl}/api/healthz`, {
        headers: { Origin: "https://evil.example" },
      });
      assert.equal(res.headers.get("access-control-allow-origin"), null);
    });

    it("configured public origin is allowed", async () => {
      const devDomain = process.env.REPLIT_DEV_DOMAIN;
      if (!devDomain) return; // nothing configured in this environment
      const origin = `https://${devDomain}`;
      const res = await fetch(`${baseUrl}/api/healthz`, {
        headers: { Origin: origin },
      });
      assert.equal(res.headers.get("access-control-allow-origin"), origin);
      assert.equal(res.headers.get("access-control-allow-credentials"), "true");
    });
  });

  // §4d OIDC redirect origin is pinned — forged Host headers must not leak in
  describe("§4d forwarded-host cannot hijack OIDC redirects", () => {
    it("GET /login with forged X-Forwarded-Host does not use it in redirect_uri", async () => {
      const res = await fetch(`${baseUrl}/api/login`, {
        redirect: "manual",
        headers: { "X-Forwarded-Host": "evil.example", Host: "evil.example" },
      });
      assert.equal(res.status, 302);
      const location = res.headers.get("location") ?? "";
      const redirectUri = new URL(location).searchParams.get("redirect_uri") ?? "";
      assert.ok(
        !redirectUri.includes("evil.example"),
        `redirect_uri must not contain a forged host: ${redirectUri}`,
      );
    });
  });

  // §4e origin resolution is fail-closed when nothing is configured
  describe("§4e getOrigin never trusts request headers", () => {
    const saved = {
      APP_ORIGIN: process.env.APP_ORIGIN,
      REPLIT_DOMAINS: process.env.REPLIT_DOMAINS,
      REPLIT_DEV_DOMAIN: process.env.REPLIT_DEV_DOMAIN,
      NODE_ENV: process.env.NODE_ENV,
    };
    function restore() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    const forgedReq = {
      headers: { "x-forwarded-host": "evil.example", host: "evil.example" },
    } as unknown as Parameters<typeof getOrigin>[0];

    it("with all origin config unset, forged hosts are never incorporated (dev)", () => {
      try {
        delete process.env.APP_ORIGIN;
        delete process.env.REPLIT_DOMAINS;
        delete process.env.REPLIT_DEV_DOMAIN;
        process.env.NODE_ENV = "development";
        const origin = getOrigin(forgedReq);
        assert.ok(!origin.includes("evil.example"), `forged host leaked: ${origin}`);
        assert.equal(origin, "http://localhost");
      } finally {
        restore();
      }
    });

    it("with all origin config unset, production refuses to build redirect URLs", () => {
      try {
        delete process.env.APP_ORIGIN;
        delete process.env.REPLIT_DOMAINS;
        delete process.env.REPLIT_DEV_DOMAIN;
        process.env.NODE_ENV = "production";
        assert.throws(() => getOrigin(forgedReq), /No public origin configured/);
      } finally {
        restore();
      }
    });

    it("unconfigured forged host falls back to the first configured domain", () => {
      try {
        delete process.env.APP_ORIGIN;
        process.env.REPLIT_DOMAINS = "myapp.replit.app";
        delete process.env.REPLIT_DEV_DOMAIN;
        const origin = getOrigin(forgedReq);
        assert.equal(origin, "https://myapp.replit.app");
      } finally {
        restore();
      }
    });
  });

  // §5 AI-route pattern coverage — structural
  describe("§5 AI limiter pattern coverage", () => {
    it("known invokeAI-calling routes are matched by isAiRoute", () => {
      for (const p of [
        "/proposals/12/run-critic",
        "/proposals/12/ai-improve-sections",
        "/proposals/check-brief",
        "/proposals/parse-brief",
        "/opportunities/12/analyze",
        "/opportunities/12/resume-analysis",
        "/opportunities/12/generate-strategy",
        "/opportunities/12/generate-proposal",
        "/opportunities/12/run-full-generation",
      ]) {
        assert.ok(isAiRoute(p), `expected AI route match: ${p}`);
      }
      assert.ok(!isAiRoute("/proposals"), "plain /proposals is not an AI route");
    });

    it("guard middlewares are mounted before all feature routers", () => {
      const src = readFileSync(
        path.resolve(__dirname, "index.ts"),
        "utf8",
      );
      const guardIdx = src.indexOf("router.use(requireAuth)");
      const firstFeature = src.indexOf("router.use(healthRouter)");
      assert.ok(guardIdx > -1 && firstFeature > -1);
      assert.ok(
        guardIdx < firstFeature,
        "requireAuth must be mounted before feature routers",
      );
    });
  });
});
