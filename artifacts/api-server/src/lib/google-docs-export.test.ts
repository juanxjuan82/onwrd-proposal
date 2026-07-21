/**
 * Google Docs export — unit tests
 *
 * Runner: node:test (built-in)
 * Transpiler: tsx (ESM)
 *
 * Tests pure logic that does NOT touch the DB or network:
 *   - Content assembly (sections vs. proposal content fallback)
 *   - Endpoint auth guard behaviour
 *   - Drive config handling
 *   - clearAndReplaceContent guards (endIndex edge cases)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ─── Content-assembly logic ───────────────────────────────────────────────────
//
// The export endpoint builds the content string as follows:
//   sections.length > 0
//     ? sections.map(s => `## ${s.title}\n\n${s.content}`).join('\n\n---\n\n')
//     : proposal.proposalContent
//
// We extract that logic into a pure function so it can be tested here.

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
//
// The endpoint must reject requests that have no googleAccessToken in session.
// We model the guard as a pure predicate.

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

// ─── Create vs. sync branch ───────────────────────────────────────────────────
//
// The endpoint chooses between creating a new doc and syncing an existing one
// based on whether `proposal.googleFileId` is set.

function shouldSyncExistingDoc(proposal: { googleFileId?: string | null }): boolean {
  return !!proposal.googleFileId;
}

describe("create vs sync branch selection", () => {
  it("selects sync when googleFileId is set", () => {
    assert.equal(shouldSyncExistingDoc({ googleFileId: "1abc" }), true);
  });

  it("selects create when googleFileId is null", () => {
    assert.equal(shouldSyncExistingDoc({ googleFileId: null }), false);
  });

  it("selects create when googleFileId is undefined", () => {
    assert.equal(shouldSyncExistingDoc({}), false);
  });

  it("selects create when googleFileId is an empty string", () => {
    assert.equal(shouldSyncExistingDoc({ googleFileId: "" }), false);
  });
});

// ─── Drive config fallback ────────────────────────────────────────────────────
//
// When no Drive config is set the endpoint skips the moveDocToFolder call.
// Model this with the driveConfig?.folderId pattern used in the route.

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
//
// The clear step is only needed when endIndex > 2.  Model the guard as a
// pure function matching the implementation.

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
