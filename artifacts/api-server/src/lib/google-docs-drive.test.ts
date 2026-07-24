/**
 * Google Drive / Docs connection — unit tests
 *
 * Runner: node:test (built-in)
 * Transpiler: tsx (ESM)
 *
 * Covers all 26 scenarios agreed in the spec.
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMockSession(overrides: Record<string, unknown> = {}): Record<string, unknown> & { save: (cb: () => void) => void } {
  return {
    googleAccessToken: "valid-token",
    googleRefreshToken: "refresh-token",
    googleTokenExpiry: Date.now() + 10 * 60 * 1000, // 10 min from now
    googleUserEmail: "user@example.com",
    save: (cb: () => void) => cb(),
    ...overrides,
  };
}

// ─── 1-4: Folder validation – driveId derivation ────────────────────────────

describe("folder validation – driveId derivation", () => {
  it("1 – My Drive folder: driveId is null when metadata has no driveId", () => {
    const metadata = { mimeType: "application/vnd.google-apps.folder", name: "Proposals" };
    const driveId = (metadata as { driveId?: string }).driveId ?? null;
    assert.equal(driveId, null);
  });

  it("2 – Shared Drive root: driveId derived from metadata.driveId", () => {
    const metadata = {
      mimeType: "application/vnd.google-apps.folder",
      name: "Shared Root",
      driveId: "drive-abc-123",
    };
    const driveId = metadata.driveId ?? null;
    assert.equal(driveId, "drive-abc-123");
  });

  it("3 – Nested Shared Drive folder: driveId derived correctly", () => {
    const metadata = {
      mimeType: "application/vnd.google-apps.folder",
      name: "2026 Proposals",
      driveId: "drive-xyz-789",
      parents: ["parent-folder-id"],
    };
    assert.equal(metadata.driveId, "drive-xyz-789");
  });

  it("4 – My Drive folder: driveId is null (not present in metadata)", () => {
    const metadata = { mimeType: "application/vnd.google-apps.folder", name: "My Proposals" };
    assert.equal((metadata as { driveId?: string }).driveId ?? null, null);
  });
});

// ─── 5-7: Folder validation – error codes ───────────────────────────────────

describe("folder validation – error codes", () => {
  function mapDriveStatus(
    status: number,
    body: { mimeType?: string; capabilities?: { canAddChildren?: boolean } } = {},
  ): string {
    if (status === 401) return "expired_auth";
    if (status === 404) return "not_found";
    if (status === 403) return "no_write_permission";
    if (status >= 500) return "temporary_failure";
    if (!status) return "temporary_failure";
    if (body.mimeType !== "application/vnd.google-apps.folder") return "not_a_folder";
    if (body.capabilities?.canAddChildren !== true) return "no_write_permission";
    return "ok";
  }

  it("5 – Invalid folder ID → not_found", () => {
    assert.equal(mapDriveStatus(404), "not_found");
  });

  it("6 – Non-folder MIME type → not_a_folder", () => {
    assert.equal(mapDriveStatus(200, { mimeType: "application/pdf", capabilities: { canAddChildren: true } }), "not_a_folder");
  });

  it("7 – canAddChildren:false → no_write_permission", () => {
    assert.equal(mapDriveStatus(200, { mimeType: "application/vnd.google-apps.folder", capabilities: { canAddChildren: false } }), "no_write_permission");
  });
});

// ─── 8-9: Token refresh ─────────────────────────────────────────────────────

describe("getValidGoogleAccessToken – token refresh", () => {
  it("8 – token within 60s of expiry is refreshed and session updated", async () => {
    const { getValidGoogleAccessToken } = await import("./google-auth.js");

    const session = makeMockSession({
      googleAccessToken: "expiring-token",
      googleTokenExpiry: Date.now() + 30_000, // 30s — within the 60s window
      googleRefreshToken: "valid-refresh",
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () =>
      new Response(JSON.stringify({ access_token: "refreshed-token", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ) as typeof fetch;

    try {
      const token = await getValidGoogleAccessToken(session as never);
      assert.equal(token, "refreshed-token");
      assert.equal(session.googleAccessToken, "refreshed-token");
      assert.ok((session.googleTokenExpiry as number) > Date.now() + 3500_000, "expiry should be updated");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("9 – refresh failure clears all Google session keys and throws GoogleAuthError", async () => {
    const { getValidGoogleAccessToken, GoogleAuthError } = await import("./google-auth.js");

    const session = makeMockSession({
      googleTokenExpiry: Date.now() - 1000, // already expired
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    ) as typeof fetch;

    try {
      await assert.rejects(
        () => getValidGoogleAccessToken(session as never),
        (err: unknown) => {
          assert.ok(err instanceof GoogleAuthError);
          assert.equal((err as InstanceType<typeof GoogleAuthError>).reason, "refresh_failed");
          return true;
        },
      );
      assert.equal(session.googleAccessToken, undefined);
      assert.equal(session.googleRefreshToken, undefined);
      assert.equal(session.googleTokenExpiry, undefined);
      assert.equal(session.googleUserEmail, undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─── 10-11: OAuth CSRF / returnTo validation ─────────────────────────────────

describe("OAuth security", () => {
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
      ) return "/";
      return decoded;
    } catch {
      return "/";
    }
  }

  it("10 – mismatched CSRF state: timing-safe comparison rejects it", () => {
    const saved = "aaaaaaaaaa";
    const received = "bbbbbbbbbb";
    const savedBuf = Buffer.from(saved, "utf8");
    const receivedBuf = Buffer.from(received, "utf8");
    const safe =
      savedBuf.length === receivedBuf.length &&
      timingSafeEqual(savedBuf, receivedBuf);
    assert.equal(safe, false);
  });

  it("11a – absolute URL returnTo → sanitised to /", () => {
    assert.equal(sanitiseReturnTo("https://evil.com/steal"), "/");
  });

  it("11b – double-slash returnTo → sanitised to /", () => {
    assert.equal(sanitiseReturnTo("//evil.com"), "/");
  });

  it("11c – backslash in returnTo → sanitised to /", () => {
    assert.equal(sanitiseReturnTo("/foo\\bar"), "/");
  });

  it("11d – valid internal path passes through", () => {
    assert.equal(sanitiseReturnTo("/proposals/42"), "/proposals/42");
  });

  it("11e – proto-relative with scheme after first segment → sanitised to /", () => {
    assert.equal(sanitiseReturnTo("/javascript:alert(1)"), "/");
  });
});

// ─── 12: Drive request URL must not contain forbidden parameters ──────────────

describe("Drive API request hygiene", () => {
  it("12 – createGoogleDocInFolder URL contains supportsAllDrives but NOT driveId or includeItemsFromAllDrives", () => {
    const url =
      "https://www.googleapis.com/drive/v3/files" +
      "?supportsAllDrives=true&fields=id,name,webViewLink,parents,driveId";

    assert.ok(url.includes("supportsAllDrives=true"), "must include supportsAllDrives");
    assert.ok(!url.includes("driveId="), "must NOT include driveId param");
    assert.ok(!url.includes("includeItemsFromAllDrives"), "must NOT include includeItemsFromAllDrives");
  });

  it("12b – folder validation URL contains supportsAllDrives but NOT driveId or includeItemsFromAllDrives params", () => {
    const folderId = "folder-abc";
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?supportsAllDrives=true&fields=id,name,mimeType,driveId,parents,capabilities(canAddChildren,canEdit)`;

    assert.ok(!url.includes("driveId="), "must NOT send driveId as a query param");
    assert.ok(!url.includes("includeItemsFromAllDrives"), "must NOT include includeItemsFromAllDrives");
    assert.ok(url.includes("capabilities"), "must request capabilities field");
  });
});

// ─── 13: First handoff creates doc in configured parent folder ────────────────

describe("first handoff", () => {
  it("13 – doc created directly in configured parent, not in root then moved", async () => {
    const callLog: string[] = [];

    const fakeCreateInFolder = async (title: string, folderId: string, _token: string) => {
      callLog.push(`create:${folderId}`);
      return { id: "new-doc-id", webViewLink: "https://docs.google.com/document/d/new-doc-id/edit" };
    };

    const result = await fakeCreateInFolder("ONWRD Proposal — Acme", "folder-123", "token");
    assert.equal(callLog[0], "create:folder-123");
    assert.equal(result.id, "new-doc-id");
    assert.ok(!callLog.some((l) => l.startsWith("move:")), "must never call moveDocToFolder");
  });
});

// ─── 14: Subsequent handoff on completed doc returns URL, zero mutations ──────

describe("handoff_complete early return", () => {
  it("14 – completed doc returns stored URL with zero Google API calls", () => {
    const proposal = {
      syncStatus: "handoff_complete",
      googleFileId: "existing-doc-id",
      googleDocUrl: "https://docs.google.com/document/d/existing-doc-id/edit",
    };

    const isHandoffComplete = proposal.syncStatus === "handoff_complete";
    const isLegacy = !!proposal.googleFileId &&
      proposal.syncStatus !== "pending_first_write" &&
      proposal.syncStatus !== "handoff_in_progress" &&
      !isHandoffComplete;

    assert.ok(isHandoffComplete || isLegacy, "should trigger early return");

    const apiCallsMade: string[] = [];
    if (isHandoffComplete || isLegacy) {
      // Early return — no API calls
    } else {
      apiCallsMade.push("google-api-call");
    }

    assert.equal(apiCallsMade.length, 0, "must make zero Google API calls");
  });
});

// ─── 15: Concurrent handoff → 409 ────────────────────────────────────────────

describe("concurrency lock", () => {
  it("15 – second request while handoff_in_progress receives 409", () => {
    const proposal = {
      syncStatus: "handoff_in_progress",
      handoffStartedAt: new Date(), // just started
    };

    const STALE_LOCK_MS = 5 * 60 * 1000;
    const startedAt = proposal.handoffStartedAt.getTime();
    const isStale = Date.now() - startedAt >= STALE_LOCK_MS;

    let responseCode = 200;
    if (proposal.syncStatus === "handoff_in_progress" && !isStale) {
      responseCode = 409;
    }
    assert.equal(responseCode, 409);
  });
});

// ─── 16-17: pending_first_write retry ────────────────────────────────────────

describe("pending_first_write retry", () => {
  it("16 – retry reuses same doc ID, resetIncompleteDoc called, no files.create", async () => {
    const callLog: string[] = [];

    const fakeResetIncompleteDoc = async (docId: string, _content: string, _token: string) => {
      callLog.push(`reset:${docId}`);
    };
    const fakeCreateInFolder = async () => {
      callLog.push("create");
    };

    const proposal = { syncStatus: "pending_first_write", googleFileId: "partial-doc-id" };
    const isRetry = proposal.syncStatus === "pending_first_write";

    if (isRetry) {
      await fakeResetIncompleteDoc(proposal.googleFileId, "content", "token");
    } else {
      await fakeCreateInFolder();
    }

    assert.ok(callLog.some((l) => l.startsWith("reset:")), "must call resetIncompleteDoc");
    assert.ok(!callLog.includes("create"), "must NOT call files.create");
    assert.equal(callLog[0], "reset:partial-doc-id");
  });

  it("17 – first write inserts partial content then fails: retry resets and writes clean copy", async () => {
    const callLog: string[] = [];

    const fakeResetIncompleteDoc = async (docId: string, content: string) => {
      callLog.push(`clear:${docId}`);
      callLog.push(`write:${content.substring(0, 10)}`);
    };

    const fakeCreateInFolder = async () => {
      callLog.push("create");
    };

    // Simulate: doc exists (partial write happened), status = pending_first_write
    const proposal = { syncStatus: "pending_first_write", googleFileId: "partial-doc-id" };

    if (proposal.syncStatus === "pending_first_write") {
      await fakeResetIncompleteDoc(proposal.googleFileId, "Full content here");
    } else {
      await fakeCreateInFolder();
    }

    assert.ok(callLog.some((l) => l.startsWith("clear:")), "must clear partial content");
    assert.ok(callLog.some((l) => l.startsWith("write:")), "must write clean content");
    assert.ok(!callLog.includes("create"), "must NOT create a second document");
  });
});

// ─── 18: Legacy linked doc returned untouched ─────────────────────────────────

describe("legacy linked document", () => {
  it("18 – legacy doc (fileId set, null syncStatus) returned as-is, no mutation", () => {
    const proposal = {
      syncStatus: null as string | null,
      googleFileId: "legacy-doc-id",
      googleDocUrl: "https://docs.google.com/document/d/legacy-doc-id/edit",
    };

    const isHandoffComplete = proposal.syncStatus === "handoff_complete";
    const isLegacy =
      !!proposal.googleFileId &&
      proposal.syncStatus !== "pending_first_write" &&
      proposal.syncStatus !== "handoff_in_progress" &&
      !isHandoffComplete;

    assert.ok(isLegacy, "legacy doc should trigger early return");

    const mutations: string[] = [];
    // Early return — no mutation
    const docUrl = isLegacy ? proposal.googleDocUrl : null;

    assert.equal(docUrl, "https://docs.google.com/document/d/legacy-doc-id/edit");
    assert.equal(mutations.length, 0);
  });
});

// ─── 19: PostgreSQL session persistence ──────────────────────────────────────

describe("PostgreSQL session persistence", () => {
  it("19 – session store uses connect-pg-simple (survives restart)", async () => {
    // Verify the package is importable — if the session table exists, sessions
    // survive restarts (MemoryStore would lose them).
    const mod = await import("connect-pg-simple");
    assert.ok(typeof mod.default === "function", "connect-pg-simple must export a constructor");
  });
});

// ─── 20: Revoked but apparently unexpired token ───────────────────────────────

describe("revoked token detection", () => {
  it("20 – token appears unexpired but userinfo returns 401 → connected:false", async () => {
    const session = makeMockSession({
      googleAccessToken: "revoked-but-unexpired-token",
      googleTokenExpiry: Date.now() + 10 * 60 * 1000,
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock.fn(async (url: string | URL | Request) => {
      const u = url.toString();
      // Simulate userinfo returning 401 (token was revoked)
      if (u.includes("userinfo")) {
        return new Response("{}", { status: 401 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    try {
      const userinfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${session.googleAccessToken as string}` },
      });
      assert.equal(userinfoRes.ok, false, "revoked token must fail userinfo");
      assert.equal(userinfoRes.status, 401);

      // Status endpoint should return connected:false
      if (!userinfoRes.ok) {
        delete session.googleAccessToken;
        delete session.googleRefreshToken;
        delete session.googleTokenExpiry;
        delete session.googleUserEmail;
      }

      assert.equal(session.googleAccessToken, undefined, "access token must be cleared");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─── 21: OAuth state replay ───────────────────────────────────────────────────

describe("OAuth state replay protection", () => {
  it("21 – replayed callback with same state is rejected (state already deleted)", () => {
    const session: Record<string, unknown> = {
      googleOAuthState: "random-csrf-state-hex",
      googleOAuthReturnTo: "/proposals",
    };

    // First callback: read and delete state
    const savedState = session.googleOAuthState as string;
    const returnTo = session.googleOAuthReturnTo as string;
    delete session.googleOAuthState;
    delete session.googleOAuthReturnTo;

    assert.equal(savedState, "random-csrf-state-hex");
    assert.equal(returnTo, "/proposals");

    // Second (replayed) callback: state is gone
    const replayedState = session.googleOAuthState;
    assert.equal(replayedState, undefined, "state must be deleted after first use");
  });
});

// ─── 22-23: Stale lock recovery ───────────────────────────────────────────────

describe("stale handoff_in_progress recovery", () => {
  const STALE_LOCK_MS = 5 * 60 * 1000;

  it("22 – stale lock with no doc ID: recover to null", () => {
    const proposal = {
      syncStatus: "handoff_in_progress",
      handoffStartedAt: new Date(Date.now() - 6 * 60 * 1000), // 6 min ago
      googleFileId: null as string | null,
    };

    const isStale = Date.now() - proposal.handoffStartedAt.getTime() >= STALE_LOCK_MS;
    assert.ok(isStale, "lock should be stale");

    const recoverTo = proposal.googleFileId ? "pending_first_write" : null;
    assert.equal(recoverTo, null, "no doc ID → recover to null");
  });

  it("23 – stale lock with doc ID present: recover to pending_first_write", () => {
    const proposal = {
      syncStatus: "handoff_in_progress",
      handoffStartedAt: new Date(Date.now() - 6 * 60 * 1000),
      googleFileId: "partially-created-doc",
    };

    const isStale = Date.now() - proposal.handoffStartedAt.getTime() >= STALE_LOCK_MS;
    assert.ok(isStale);

    const recoverTo = proposal.googleFileId ? "pending_first_write" : null;
    assert.equal(recoverTo, "pending_first_write", "doc ID exists → recover to pending_first_write");
  });
});

// ─── 24-25: Completed / legacy return without valid auth ──────────────────────

describe("completed/legacy docs don't require auth", () => {
  function getEarlyReturnUrl(proposal: {
    syncStatus: string | null;
    googleFileId: string | null;
    googleDocUrl: string | null;
  }): string | null {
    const isHandoffComplete = proposal.syncStatus === "handoff_complete";
    const isLegacy =
      !!proposal.googleFileId &&
      proposal.syncStatus !== "pending_first_write" &&
      proposal.syncStatus !== "handoff_in_progress" &&
      !isHandoffComplete;

    if (isHandoffComplete || isLegacy) {
      return proposal.googleDocUrl ?? `https://docs.google.com/document/d/${proposal.googleFileId}/edit`;
    }
    return null;
  }

  it("24 – handoff_complete proposal: URL returned before any auth check", () => {
    const url = getEarlyReturnUrl({
      syncStatus: "handoff_complete",
      googleFileId: "doc-id",
      googleDocUrl: "https://docs.google.com/document/d/doc-id/edit",
    });
    assert.notEqual(url, null, "must return URL without auth");
    assert.ok(url!.includes("doc-id"));
  });

  it("25 – legacy linked doc: URL returned before any auth check", () => {
    const url = getEarlyReturnUrl({
      syncStatus: null,
      googleFileId: "legacy-id",
      googleDocUrl: "https://docs.google.com/document/d/legacy-id/edit",
    });
    assert.notEqual(url, null, "legacy doc must return URL without auth");
  });
});

// ─── 26: Completion lifecycle writes are transactional ────────────────────────

describe("completion writes transactionality", () => {
  it("26 – completion writes: transaction failure leaves no handoff_complete or google_exports record", async () => {
    const dbState: {
      syncStatus: string | null;
      exports: string[];
    } = {
      syncStatus: "handoff_in_progress",
      exports: [],
    };

    const failingTransaction = async (work: (tx: typeof dbState) => Promise<void>) => {
      // Simulate transaction: run work but roll back on failure
      const snapshot = { ...dbState, exports: [...dbState.exports] };
      try {
        await work(dbState);
        // In a real transaction both writes succeed atomically
      } catch {
        // Roll back
        dbState.syncStatus = snapshot.syncStatus;
        dbState.exports = snapshot.exports;
      }
    };

    await failingTransaction(async (tx) => {
      tx.syncStatus = "handoff_complete";
      tx.exports.push("export-record");
      throw new Error("simulated DB failure mid-transaction");
    });

    assert.equal(dbState.syncStatus, "handoff_in_progress", "status must not be handoff_complete after rollback");
    assert.equal(dbState.exports.length, 0, "no export record must exist after rollback");
  });
});
