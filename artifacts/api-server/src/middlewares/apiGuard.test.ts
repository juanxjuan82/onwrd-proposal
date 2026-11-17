/**
 * requireAuth — Clerk identity resolution & cross-user session isolation
 *
 * Runner: node:test + tsx  (node --import tsx/esm --test this-file.ts)
 *
 * These are regression tests for a completion-review rejection during the
 * Clerk migration:
 *
 *   1. `auth.sessionClaims.email` is undefined on Clerk's default session
 *      token (no custom JWT template is configured for this app). Reading
 *      it directly — instead of resolving the verified email via the Clerk
 *      backend API by `auth.userId` — would silently 403 every real user.
 *   2. The Express session cookie (which holds Google Drive OAuth tokens)
 *      is independent of Clerk's own session cookie. Without an explicit
 *      cross-check, a second Clerk user signing in through the same browser
 *      session (e.g. after the first user signs out) would inherit the
 *      first user's Drive tokens.
 *
 * Uses the test-only `__setGetAuthOverrideForTesting` /
 * `__setGetClerkUserOverrideForTesting` seams (both null in production) to
 * drive Clerk identity deterministically, without a real Clerk session.
 */
process.env.NODE_ENV = "test";
process.env.AUTH_GUARD_TEST = "1"; // keep the deny-by-default guard ACTIVE in this suite

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";

import app, { dbReady } from "../app.js";
import { pool } from "@workspace/db";
import {
  __setGetAuthOverrideForTesting,
  __setGetClerkUserOverrideForTesting,
} from "./apiGuard.js";

let server: Server;
let baseUrl: string;

function extractSid(setCookieHeader: string): string {
  const match = /connect\.sid=([^;]+)/.exec(setCookieHeader);
  assert.ok(match, "expected a connect.sid cookie in the response");
  const raw = decodeURIComponent(match![1]); // "s:<sid>.<hmac>"
  const withoutPrefix = raw.startsWith("s:") ? raw.slice(2) : raw;
  const lastDot = withoutPrefix.lastIndexOf(".");
  return lastDot === -1 ? withoutPrefix : withoutPrefix.slice(0, lastDot);
}

async function deleteTestUsers(emails: string[]): Promise<void> {
  if (emails.length === 0) return;
  await pool.query(`DELETE FROM users WHERE email = ANY($1)`, [emails]);
}

/**
 * connect-pg-simple's session.save() callback (and therefore the HTTP
 * response) can resolve a hair before the row is visible to a fresh query
 * from this test's own pool connection. Poll briefly rather than assume
 * strict same-tick visibility.
 */
async function waitForSessionRow(sid: string): Promise<void> {
  await waitForSessionField(sid, () => true, "session row never appeared");
}

/**
 * Same reasoning as waitForSessionRow, but polls until a specific write is
 * visible (e.g. a session.save() from a just-completed fetch()) rather than
 * just row existence — a fetch() resolving does not guarantee this test's
 * own separate pool connection can already see that write.
 */
async function waitForSessionField(
  sid: string,
  predicate: (sess: Record<string, unknown>) => boolean,
  timeoutMessage: string,
): Promise<Record<string, unknown>> {
  for (let i = 0; i < 40; i++) {
    const { rows } = await pool.query<{ sess: Record<string, unknown> }>(
      `SELECT sess FROM session WHERE sid = $1`,
      [sid],
    );
    if (rows[0] && predicate(rows[0].sess)) return rows[0].sess;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`sid=${sid}: ${timeoutMessage}`);
}

describe("requireAuth — Clerk identity resolution & session isolation", () => {
  before(async () => {
    await dbReady;
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (addr == null || typeof addr === "string") throw new Error("no port");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(() => {
    __setGetAuthOverrideForTesting(null);
    __setGetClerkUserOverrideForTesting(null);
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end().catch(() => {});
  });

  it("resolves identity via the Clerk backend API, NOT sessionClaims.email (which is absent by default)", async () => {
    // The override supplies only `userId` — exactly what Clerk's default
    // session token contains. If requireAuth ever regresses to reading
    // `auth.sessionClaims.email` directly, this request would 403 because
    // no such claim exists.
    __setGetAuthOverrideForTesting(() => ({ userId: "user_default_claims_test" }));
    __setGetClerkUserOverrideForTesting(async () => ({
      primaryEmailAddressId: "eml_1",
      emailAddresses: [
        {
          id: "eml_1",
          emailAddress: "default-claims-test@onwrdadvisors.com",
          verification: { status: "verified" },
        },
      ],
    }));

    try {
      const res = await fetch(`${baseUrl}/api/proposals`);
      assert.notEqual(res.status, 401);
      assert.notEqual(res.status, 403);
    } finally {
      await deleteTestUsers(["default-claims-test@onwrdadvisors.com"]);
    }
  });

  it("rejects a verified email outside the company domain", async () => {
    __setGetAuthOverrideForTesting(() => ({ userId: "user_outside_domain_test" }));
    __setGetClerkUserOverrideForTesting(async () => ({
      primaryEmailAddressId: "eml_2",
      emailAddresses: [
        { id: "eml_2", emailAddress: "someone@gmail.com", verification: { status: "verified" } },
      ],
    }));

    const res = await fetch(`${baseUrl}/api/proposals`);
    assert.equal(res.status, 403);
    const body = (await res.json()) as { code?: string };
    assert.equal(body.code, "domain_not_allowed");
  });

  it("rejects an unverified primary email even on the company domain", async () => {
    __setGetAuthOverrideForTesting(() => ({ userId: "user_unverified_test" }));
    __setGetClerkUserOverrideForTesting(async () => ({
      primaryEmailAddressId: "eml_3",
      emailAddresses: [
        {
          id: "eml_3",
          emailAddress: "unverified@onwrdadvisors.com",
          verification: { status: "unverified" },
        },
      ],
    }));

    const res = await fetch(`${baseUrl}/api/proposals`);
    assert.equal(res.status, 403);
  });

  it("clears Google Drive tokens left in the Express session when a different Clerk user authenticates", async () => {
    const emailA = "drive-isolation-a@onwrdadvisors.com";
    const emailB = "drive-isolation-b@onwrdadvisors.com";

    __setGetAuthOverrideForTesting(() => ({ userId: "user_drive_a" }));
    __setGetClerkUserOverrideForTesting(async (clerkUserId: string) => {
      const email = clerkUserId === "user_drive_a" ? emailA : emailB;
      return {
        primaryEmailAddressId: "eml",
        emailAddresses: [{ id: "eml", emailAddress: email, verification: { status: "verified" } }],
      };
    });

    try {
      // 1. User A authenticates, establishing an Express session bound to A.
      const resA = await fetch(`${baseUrl}/api/auth/google/status`);
      assert.equal(resA.status, 200);
      const setCookie = resA.headers.get("set-cookie");
      assert.ok(setCookie, "expected a session cookie to be issued");
      const sid = extractSid(setCookie!);
      const cookiePair = setCookie!.split(";")[0];

      // 2. Simulate A having connected Google Drive, by writing fake tokens
      //    straight into that session row (bypassing the real OAuth dance).
      await waitForSessionRow(sid);
      const updateResult = await pool.query(
        `UPDATE session SET sess = (sess::jsonb || $2::jsonb)::json WHERE sid = $1`,
        [sid, JSON.stringify({ googleAccessToken: "fake-token-a", googleUserEmail: emailA })],
      );
      assert.equal(updateResult.rowCount, 1, "expected to seed exactly one session row");

      // 3. The same browser session now authenticates as a DIFFERENT Clerk
      //    user (e.g. A signed out, B signed in) but reuses the same
      //    Express session cookie — Clerk sign-out never touches it.
      __setGetAuthOverrideForTesting(() => ({ userId: "user_drive_b" }));
      const resB = await fetch(`${baseUrl}/api/auth/google/status`, {
        headers: { Cookie: cookiePair },
      });
      assert.equal(resB.status, 200);
      const bodyB = (await resB.json()) as { connected?: boolean; email?: string | null };
      assert.equal(bodyB.connected, false, "B must not inherit A's Drive connection");
      assert.notEqual(bodyB.email, emailA, "B must never see A's email");

      const { rows } = await pool.query<{ sess: Record<string, unknown> }>(
        `SELECT sess FROM session WHERE sid = $1`,
        [sid],
      );
      assert.ok(rows[0], "session row should still exist");
      assert.equal(
        rows[0].sess.googleAccessToken,
        undefined,
        "A's Drive access token must be wiped once B authenticates",
      );
      assert.equal(rows[0].sess.clerkUserId, "user_drive_b", "session should now be bound to B");
    } finally {
      await deleteTestUsers([emailA, emailB]);
    }
  });

  it("refuses to bind Google Drive tokens if a different Clerk user completes the OAuth callback (sign-out/sign-in race)", async () => {
    const emailA = "oauth-race-a@onwrdadvisors.com";
    const emailB = "oauth-race-b@onwrdadvisors.com";

    __setGetAuthOverrideForTesting(() => ({ userId: "user_oauth_race_a" }));
    __setGetClerkUserOverrideForTesting(async (clerkUserId: string) => {
      const email = clerkUserId === "user_oauth_race_a" ? emailA : emailB;
      return {
        primaryEmailAddressId: "eml",
        emailAddresses: [{ id: "eml", emailAddress: email, verification: { status: "verified" } }],
      };
    });

    try {
      // 1. User A initiates Google OAuth (authenticated route — binds the
      //    flow's state to A's Clerk user ID via googleOAuthClerkUserId).
      const resInitiate = await fetch(`${baseUrl}/api/auth/google?returnTo=%2Fsettings`, {
        redirect: "manual",
      });
      assert.equal(resInitiate.status, 302);
      const setCookie = resInitiate.headers.get("set-cookie");
      assert.ok(setCookie, "expected a session cookie to be issued");
      const sid = extractSid(setCookie!);
      const cookiePair = setCookie!.split(";")[0];
      const location = resInitiate.headers.get("location");
      assert.ok(location, "expected a redirect to Google's OAuth consent screen");
      const state = new URL(location!).searchParams.get("state");
      assert.ok(state, "expected a state param in the Google redirect URL");

      // 2. Before A's callback lands, A signs out and B signs in through the
      //    SAME browser (same Express session cookie — Clerk's own session
      //    cookie is independent and unaffected by this Express cookie).
      __setGetAuthOverrideForTesting(() => ({ userId: "user_oauth_race_b" }));
      const resSwitch = await fetch(`${baseUrl}/api/auth/google/status`, {
        headers: { Cookie: cookiePair },
      });
      assert.equal(resSwitch.status, 200);
      // A fetch() resolving doesn't guarantee this test's own separate pool
      // connection can already see resSwitch's write — wait for it.
      await waitForSessionField(
        sid,
        (sess) => sess.clerkUserId === "user_oauth_race_b",
        "session was never rebound to B",
      );

      // 3. A's delayed callback now arrives, but the browser is currently
      //    authenticated as B. It must be rejected before any tokens are
      //    saved, and it must NOT need to reach Google's token endpoint.
      const resCallback = await fetch(
        `${baseUrl}/api/auth/google/callback?code=fake-code&state=${encodeURIComponent(state!)}`,
        { headers: { Cookie: cookiePair }, redirect: "manual" },
      );
      assert.equal(resCallback.status, 302);
      const callbackLocation = resCallback.headers.get("location");
      assert.ok(callbackLocation?.includes("google_error=1"), "expected the callback to report an error, not connect");

      const { rows } = await pool.query<{ sess: Record<string, unknown> }>(
        `SELECT sess FROM session WHERE sid = $1`,
        [sid],
      );
      assert.ok(rows[0], "session row should still exist");
      assert.equal(
        rows[0].sess.googleAccessToken,
        undefined,
        "A's Google tokens must never be saved into B's session",
      );
      assert.equal(rows[0].sess.clerkUserId, "user_oauth_race_b", "session should remain bound to B");
    } finally {
      await deleteTestUsers([emailA, emailB]);
    }
  });
});
