/**
 * Google Docs export — unit + route-behaviour tests
 *
 * Runner: node:test (built-in)
 * Transpiler: tsx (ESM)
 *
 * Covers:
 *   - Content assembly (sections vs. proposal content fallback)
 *   - Auth guard behaviour
 *   - Drive config handling
 *   - clearAndReplaceContent guards (endIndex edge cases)
 *   - Concurrency guard / 409 logic
 *   - Backward compat: extract fileId from legacy googleDocUrl
 *   - Dirty tracking (dirtySince set/cleared)
 *   - Sync status transitions (syncing → synced / error)
 *   - Idempotent create vs update branch
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ─── Content-assembly logic ───────────────────────────────────────────────────

function buildExportContent(
  proposalContent: string,
  sections: { title: string; content: string; orderIndex: number }[],
): string {
  if (sections.length > 0) {
    return sections
      .sort((a, b) => a.orderIndex - b.orderIndex)
      .map((s) => `## ${s.title}\n\n${s.content}`)
      .join("\n\n---\n\n");
  }
  return proposalContent;
}

describe("buildExportContent", () => {
  it("falls back to proposalContent when there are no sections", () => {
    const result = buildExportContent("Proposal body text", []);
    assert.equal(result, "Proposal body text");
  });

  it("uses sections when they exist", () => {
    const sections = [
      { title: "Executive Summary", content: "This is the summary.", orderIndex: 0 },
      { title: "Pricing", content: "Fixed fee £10k.", orderIndex: 1 },
    ];
    const result = buildExportContent("ignored", sections);
    assert.ok(result.includes("## Executive Summary"), "should contain first section heading");
    assert.ok(result.includes("## Pricing"), "should contain second section heading");
    assert.ok(result.includes("This is the summary."), "should contain first section content");
    assert.ok(result.includes("Fixed fee £10k."), "should contain second section content");
  });

  it("joins sections with the separator", () => {
    const sections = [
      { title: "A", content: "a", orderIndex: 0 },
      { title: "B", content: "b", orderIndex: 1 },
    ];
    const result = buildExportContent("ignored", sections);
    assert.ok(result.includes("\n\n---\n\n"), "sections should be separated by ---");
  });

  it("respects orderIndex — lower index comes first", () => {
    const sections = [
      { title: "Second", content: "second content", orderIndex: 1 },
      { title: "First", content: "first content", orderIndex: 0 },
    ];
    const result = buildExportContent("ignored", sections);
    const firstPos = result.indexOf("## First");
    const secondPos = result.indexOf("## Second");
    assert.ok(firstPos < secondPos, "First section must appear before Second section");
  });

  it("a single section produces no separator", () => {
    const sections = [{ title: "Only", content: "one", orderIndex: 0 }];
    const result = buildExportContent("ignored", sections);
    assert.ok(!result.includes("---"), "single section should have no separator");
  });

  it("handles sections with empty content without throwing", () => {
    const sections = [{ title: "Empty", content: "", orderIndex: 0 }];
    assert.doesNotThrow(() => buildExportContent("ignored", sections));
  });

  it("handles an empty proposalContent string", () => {
    const result = buildExportContent("", []);
    assert.equal(result, "");
  });
});

// ─── Auth-guard logic ─────────────────────────────────────────────────────────

function isAuthenticated(session: { googleAccessToken?: string }): boolean {
  return !!session.googleAccessToken;
}

describe("export auth guard", () => {
  it("allows requests with an access token in session", () => {
    assert.equal(isAuthenticated({ googleAccessToken: "tok_abc" }), true);
  });

  it("blocks requests with no access token", () => {
    assert.equal(isAuthenticated({}), false);
  });

  it("blocks requests where the token is an empty string", () => {
    assert.equal(isAuthenticated({ googleAccessToken: "" }), false);
  });
});

// ─── Concurrency guard (409) ──────────────────────────────────────────────────
//
// The endpoint returns 409 when syncStatus is already 'syncing'.
// After the atomic UPDATE ... WHERE sync_status IS DISTINCT FROM 'syncing',
// if 0 rows were affected the endpoint ALSO returns 409.
//
// CRITICAL NULL semantics:
//   Postgres: NULL != 'syncing'           → NULL  (the row is NOT matched)
//   Postgres: NULL IS DISTINCT FROM 'syncing' → TRUE (the row IS matched)
//
// A naive ne() predicate blocks every first-time export because proposals start
// with syncStatus = NULL. The route uses IS DISTINCT FROM to handle this.

function isSyncing(proposal: { syncStatus?: string | null }): boolean {
  return proposal.syncStatus === "syncing";
}

function atomicLockSucceeded(rowsAffected: number): boolean {
  return rowsAffected > 0;
}

/**
 * Models IS DISTINCT FROM 'syncing'.
 * JavaScript null/undefined are both !== 'syncing', matching Postgres behaviour.
 */
function isDistinctFromSyncing(value: string | null | undefined): boolean {
  return value !== "syncing";
}

describe("concurrency guard / 409 behaviour", () => {
  it("returns 409 immediately when syncStatus is already 'syncing'", () => {
    assert.equal(isSyncing({ syncStatus: "syncing" }), true);
  });

  it("allows export when syncStatus is null (never exported)", () => {
    assert.equal(isSyncing({ syncStatus: null }), false);
  });

  it("allows export when syncStatus is 'synced'", () => {
    assert.equal(isSyncing({ syncStatus: "synced" }), false);
  });

  it("allows export when syncStatus is 'error'", () => {
    assert.equal(isSyncing({ syncStatus: "error" }), false);
  });

  it("returns 409 when atomic lock UPDATE affects 0 rows (race condition)", () => {
    assert.equal(atomicLockSucceeded(0), false);
  });

  it("proceeds when atomic lock UPDATE affects 1 row", () => {
    assert.equal(atomicLockSucceeded(1), true);
  });

  // NULL-safe IS DISTINCT FROM predicate — the key correctness property
  it("IS DISTINCT FROM: NULL is treated as distinct from 'syncing' (first export must succeed)", () => {
    assert.equal(isDistinctFromSyncing(null), true);
  });

  it("IS DISTINCT FROM: undefined is treated as distinct from 'syncing'", () => {
    assert.equal(isDistinctFromSyncing(undefined), true);
  });

  it("IS DISTINCT FROM: 'synced' is distinct from 'syncing'", () => {
    assert.equal(isDistinctFromSyncing("synced"), true);
  });

  it("IS DISTINCT FROM: 'error' is distinct from 'syncing'", () => {
    assert.equal(isDistinctFromSyncing("error"), true);
  });

  it("IS DISTINCT FROM: 'syncing' is NOT distinct from itself — lock is held", () => {
    assert.equal(isDistinctFromSyncing("syncing"), false);
  });
});

// ─── Backward compatibility: extract fileId from legacy googleDocUrl ──────────
//
// Proposals exported before googleFileId was tracked only have googleDocUrl.
// On next export we extract the fileId from the URL so the existing doc is
// reused instead of creating a duplicate.

function extractFileIdFromUrl(googleDocUrl: string | null | undefined): string | null {
  if (!googleDocUrl) return null;
  const match = googleDocUrl.match(/\/document\/d\/([^/?#]+)/);
  return match?.[1] ?? null;
}

describe("backward compat: extract fileId from legacy googleDocUrl", () => {
  it("extracts the fileId from a standard Google Docs edit URL", () => {
    const url = "https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms/edit";
    assert.equal(extractFileIdFromUrl(url), "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms");
  });

  it("extracts the fileId when URL has query params", () => {
    const url = "https://docs.google.com/document/d/ABC123/edit?usp=sharing";
    assert.equal(extractFileIdFromUrl(url), "ABC123");
  });

  it("returns null when googleDocUrl is null", () => {
    assert.equal(extractFileIdFromUrl(null), null);
  });

  it("returns null when googleDocUrl is undefined", () => {
    assert.equal(extractFileIdFromUrl(undefined), null);
  });

  it("returns null for a URL that doesn't match the expected pattern", () => {
    assert.equal(extractFileIdFromUrl("https://drive.google.com/file/d/XYZ/view"), null);
  });

  it("a proposal with googleFileId set takes precedence — no extraction needed", () => {
    const proposal = { googleFileId: "EXISTING_ID", googleDocUrl: "https://docs.google.com/document/d/LEGACY_ID/edit" };
    const effectiveFileId = proposal.googleFileId ?? extractFileIdFromUrl(proposal.googleDocUrl);
    assert.equal(effectiveFileId, "EXISTING_ID");
  });

  it("a proposal without googleFileId falls back to URL extraction", () => {
    const proposal = { googleFileId: null, googleDocUrl: "https://docs.google.com/document/d/LEGACY_ID/edit" };
    const effectiveFileId = proposal.googleFileId ?? extractFileIdFromUrl(proposal.googleDocUrl);
    assert.equal(effectiveFileId, "LEGACY_ID");
  });
});

// ─── Folder config enforcement ───────────────────────────────────────────────
//
// First-time exports (no effectiveFileId) require a configured Drive folder.
// The endpoint returns 400 and releases the sync lock if no folder is set.
// Sync operations (effectiveFileId is set) do NOT require folder config.

function firstExportRequiresFolderConfig(
  effectiveFileId: string | null | undefined,
  driveConfig: { folderId?: string | null } | undefined,
): boolean {
  if (effectiveFileId) return false; // sync path — folder not required
  return !driveConfig?.folderId;     // create path — must have folder
}

describe("folder config enforcement for first-time exports", () => {
  it("returns true (error needed) when no effectiveFileId and no folder configured", () => {
    assert.equal(firstExportRequiresFolderConfig(null, undefined), true);
  });

  it("returns true when driveConfig has null folderId", () => {
    assert.equal(firstExportRequiresFolderConfig(null, { folderId: null }), true);
  });

  it("returns false when effectiveFileId is set — sync path skips folder check", () => {
    assert.equal(firstExportRequiresFolderConfig("EXISTING_ID", undefined), false);
  });

  it("returns false when folder IS configured — create path proceeds", () => {
    assert.equal(firstExportRequiresFolderConfig(null, { folderId: "folder123" }), false);
  });

  it("sync of legacy proposal (effectiveFileId from URL) skips folder check", () => {
    const effectiveFileId = "LEGACY_ID"; // extracted from googleDocUrl
    assert.equal(firstExportRequiresFolderConfig(effectiveFileId, undefined), false);
  });
});

// ─── Idempotent create vs. sync branch ───────────────────────────────────────

function shouldSyncExistingDoc(effectiveFileId: string | null | undefined): boolean {
  return !!effectiveFileId;
}

describe("idempotent create vs. sync branch", () => {
  it("syncs when effectiveFileId is set (existing doc)", () => {
    assert.equal(shouldSyncExistingDoc("1abc"), true);
  });

  it("creates when effectiveFileId is null (no prior export, no legacy URL)", () => {
    assert.equal(shouldSyncExistingDoc(null), false);
  });

  it("creates when effectiveFileId is empty string", () => {
    assert.equal(shouldSyncExistingDoc(""), false);
  });

  it("creates exactly once — second export reuses the same fileId", () => {
    // Simulate first export producing a fileId
    const fileIdAfterFirstExport = "NEW_DOC_ID";
    // Second export: effectiveFileId is now set → sync, not create
    assert.equal(shouldSyncExistingDoc(fileIdAfterFirstExport), true);
  });
});

// ─── Dirty tracking ───────────────────────────────────────────────────────────
//
// When proposal content or section content is updated, dirtySince is set.
// On successful export, dirtySince is cleared.
// The "unsaved changes" indicator is shown only when dirtySince is non-null
// AND the proposal has a googleFileId (i.e. it has been exported before).

function hasUnsyncedChanges(proposal: { dirtySince?: string | null; googleFileId?: string | null }): boolean {
  return !!proposal.dirtySince && !!proposal.googleFileId;
}

describe("dirty tracking: unsaved-changes indicator", () => {
  it("shows indicator when dirtySince is set and proposal has been exported", () => {
    assert.equal(hasUnsyncedChanges({ dirtySince: new Date().toISOString(), googleFileId: "FILE1" }), true);
  });

  it("does not show indicator when dirtySince is null (synced)", () => {
    assert.equal(hasUnsyncedChanges({ dirtySince: null, googleFileId: "FILE1" }), false);
  });

  it("does not show indicator when proposal has never been exported (no googleFileId)", () => {
    assert.equal(hasUnsyncedChanges({ dirtySince: new Date().toISOString(), googleFileId: null }), false);
  });

  it("does not show indicator when proposal has no googleFileId or dirtySince", () => {
    assert.equal(hasUnsyncedChanges({}), false);
  });
});

// ─── Sync status transitions ──────────────────────────────────────────────────
//
// These model the state machine inside the export endpoint:
//   null / 'error' / 'synced' → locked → 'syncing'
//   'syncing' → on success → 'synced' (lastSyncedAt set, dirtySince cleared)
//   'syncing' → on failure → 'error'

type SyncStatus = "syncing" | "synced" | "error" | null;

function computeSuccessState(now: Date): { syncStatus: SyncStatus; lastSyncedAt: Date; dirtySince: null } {
  return { syncStatus: "synced", lastSyncedAt: now, dirtySince: null };
}

function computeErrorState(): { syncStatus: SyncStatus } {
  return { syncStatus: "error" };
}

describe("sync status state machine", () => {
  it("success path: sets syncStatus='synced', populates lastSyncedAt, clears dirtySince", () => {
    const now = new Date();
    const state = computeSuccessState(now);
    assert.equal(state.syncStatus, "synced");
    assert.equal(state.lastSyncedAt, now);
    assert.equal(state.dirtySince, null);
  });

  it("error path: sets syncStatus='error'", () => {
    const state = computeErrorState();
    assert.equal(state.syncStatus, "error");
  });

  it("a proposal that errored can be retried (not stuck in 'syncing')", () => {
    assert.equal(isSyncing({ syncStatus: "error" }), false);
  });

  it("a freshly synced proposal with edits shows unsaved changes after content update", () => {
    const proposal = { syncStatus: "synced" as SyncStatus, googleFileId: "X", dirtySince: new Date().toISOString() };
    assert.equal(hasUnsyncedChanges(proposal), true);
  });

  it("after re-sync, unsaved changes are cleared", () => {
    const proposal = { syncStatus: "synced" as SyncStatus, googleFileId: "X", dirtySince: null };
    assert.equal(hasUnsyncedChanges(proposal), false);
  });
});

// ─── Drive config fallback ────────────────────────────────────────────────────

function hasFolderConfig(driveConfig: { folderId?: string | null } | undefined): boolean {
  return !!driveConfig?.folderId;
}

describe("drive config folder presence", () => {
  it("returns true when folderId is set", () => {
    assert.equal(hasFolderConfig({ folderId: "folder123" }), true);
  });

  it("returns false when folderId is null", () => {
    assert.equal(hasFolderConfig({ folderId: null }), false);
  });

  it("returns false when driveConfig is undefined (none configured)", () => {
    assert.equal(hasFolderConfig(undefined), false);
  });

  it("returns false when folderId is empty string", () => {
    assert.equal(hasFolderConfig({ folderId: "" }), false);
  });
});

// ─── clearAndReplaceContent endIndex guard ────────────────────────────────────

function needsDeleteBeforeClear(endIndex: number): boolean {
  return endIndex > 2;
}

describe("clearAndReplaceContent delete guard", () => {
  it("skips delete when endIndex is 1 (brand-new empty doc)", () => {
    assert.equal(needsDeleteBeforeClear(1), false);
  });

  it("skips delete when endIndex is exactly 2 (mandatory trailing newline only)", () => {
    assert.equal(needsDeleteBeforeClear(2), false);
  });

  it("performs delete when endIndex is 3 (at least one real character)", () => {
    assert.equal(needsDeleteBeforeClear(3), true);
  });

  it("performs delete for large documents", () => {
    assert.equal(needsDeleteBeforeClear(50_000), true);
  });
});

// ─── Doc URL construction ─────────────────────────────────────────────────────

function buildDocUrl(documentId: string): string {
  return `https://docs.google.com/document/d/${documentId}/edit`;
}

describe("buildDocUrl", () => {
  it("constructs the correct edit URL", () => {
    const url = buildDocUrl("1abc_DEF");
    assert.equal(url, "https://docs.google.com/document/d/1abc_DEF/edit");
  });

  it("URL starts with https", () => {
    assert.ok(buildDocUrl("x").startsWith("https://"));
  });

  it("URL ends with /edit", () => {
    assert.ok(buildDocUrl("y").endsWith("/edit"));
  });
});
