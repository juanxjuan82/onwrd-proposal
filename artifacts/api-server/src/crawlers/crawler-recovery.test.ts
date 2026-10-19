import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  canRefreshIncompleteDiscovery,
  mergeCrawlerRawData,
  mergeDocumentEvidence,
  sameDiscovery,
} from "./crawler-recovery.js";
import type { ExistingDiscovery } from "./crawler-recovery.js";

const title = "Regional public awareness campaign services";
const scope = "The selected firm will design a communications strategy, develop public information materials, " +
  "coordinate stakeholder interviews, deliver a regional awareness campaign, and submit final reports.";

function existing(overrides: Partial<ExistingDiscovery> = {}): ExistingDiscovery {
  return {
    title,
    organization: "CARICOM Secretariat",
    description: `CARICOM Secretariat procurement notice: ${title}`,
    status: "new",
    opportunityId: null,
    deadline: null,
    country: "Caribbean",
    sector: "Communications",
    rawData: {
      needsEnrichment: true,
      crawlerManagedSnapshot: {
        title,
        organization: "CARICOM Secretariat",
        description: `CARICOM Secretariat procurement notice: ${title}`,
      },
    },
    ...overrides,
  };
}

describe("crawler recovery safety", () => {
  it("refreshes an incomplete crawler-owned record when real scope arrives", () => {
    assert.equal(canRefreshIncompleteDiscovery(existing(), { title, organization: "new label", description: scope }), true);
  });

  it("does not replace changed human text, a human decision, or a linked opportunity", () => {
    assert.equal(canRefreshIncompleteDiscovery(existing({ description: "Human note: verify with procurement contact." }), {
      title, organization: "CARICOM Secretariat", description: scope,
    }), false);
    assert.equal(canRefreshIncompleteDiscovery(existing({ status: "dismissed" }), {
      title, organization: "CARICOM Secretariat", description: scope,
    }), false);
    assert.equal(canRefreshIncompleteDiscovery(existing({ opportunityId: 91 }), {
      title, organization: "CARICOM Secretariat", description: scope,
    }), false);
    assert.equal(canRefreshIncompleteDiscovery(existing({ rawData: { userEdited: true } }), {
      title, organization: "CARICOM Secretariat", description: scope,
    }), false);
  });

  it("preserves source-independent human metadata while refreshing only known crawler evidence", () => {
    const merged = mergeCrawlerRawData(
      { reviewNote: "Keep this", sourcePage: "old-page", userDecision: "watch" },
      { sourcePage: "new-page", descriptionStatus: "substantive", madeUpField: "ignore" },
    );
    assert.deepEqual(merged, {
      reviewNote: "Keep this",
      sourcePage: "new-page",
      userDecision: "watch",
      descriptionStatus: "substantive",
    });
  });

  it("merges document provenance idempotently and retains earlier extracted text on a failed retry", () => {
    const original = {
      reviewerMarker: "preserve",
      documentExtraction: [{
        url: "https://www.caribank.org/files/tor.pdf",
        format: "pdf",
        status: "extracted",
        characters: 90,
        extractedText: "verified TOR text",
      }],
    };
    assert.equal(mergeDocumentEvidence(original, {
      documentExtraction: [{
        url: "https://www.caribank.org/files/tor.pdf",
        format: "pdf",
        status: "fetch_failed",
        characters: 0,
      }],
    }), undefined);
    assert.equal(mergeDocumentEvidence(original, {
      documentExtraction: [{
        url: "https://www.caribank.org/files/tor.pdf",
        format: "pdf",
        status: "extracted",
        characters: 90,
        extractedText: "verified TOR text",
      }],
    }), undefined);
    const newEvidence = mergeDocumentEvidence(original, {
      documentExtraction: [{
        url: "https://www.caribank.org/files/amendment.pdf",
        format: "pdf",
        status: "extracted",
        characters: 100,
        extractedText: "amendment details",
      }],
    });
    assert.equal(newEvidence?.reviewerMarker, "preserve");
    assert.equal((newEvidence?.documentExtraction as Array<{url:string}>).length, 2);
  });

  it("matches repeated notices by stable identifier or normalized source URL", () => {
    assert.equal(sameDiscovery(
      { externalId: "old-id", url: "https://caribank.org/notice/abc/" },
      { externalId: "new-id", url: "https://caribank.org/notice/abc#files" },
    ), true);
    assert.equal(sameDiscovery(
      { externalId: "same-id", url: "https://caribank.org/notice/old" },
      { externalId: "same-id", url: "https://caribank.org/notice/new" },
    ), true);
  });

  it("keeps recovery updates guarded and routed through canonical promotion", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const recovery = source.slice(source.indexOf("if (canRefreshIncompleteDiscovery"), source.indexOf("// Deduplicate by URL"));
    assert.match(recovery, /eq\(discoveredTendersTable\.status,\s*"new"\)/);
    assert.match(recovery, /isNull\(discoveredTendersTable\.opportunityId\)/);
    assert.match(recovery, /fitScore:\s*refreshedScore\.fitScore/);
    assert.match(recovery, /promoteDiscoveredTender\(existing\.id/);
    assert.doesNotMatch(recovery, /\btitle:\s*opp\.title/);
    assert.doesNotMatch(recovery, /\borganization:\s*opp\.organization/);
  });

  it("updates linked discoveries with document evidence only, leaving proposal-backed opportunities alone", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const linked = source.slice(
      source.indexOf("if (existing.opportunityId !== null)"),
      source.indexOf("if (canRefreshIncompleteDiscovery"),
    );
    assert.match(linked, /mergeDocumentEvidence/);
    assert.match(linked, /rawData:\s*evidenceOnlyRaw/);
    assert.match(linked, /eq\(discoveredTendersTable\.opportunityId,\s*existing\.opportunityId\)/);
    assert.doesNotMatch(linked, /description:|deadline:|recommendation:|status:|opportunityId:/);
  });

  it("keeps robots-blocked and controlled-pilot sources inactive without their own proof", () => {
    const crawler = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const routes = readFileSync(new URL("../routes/tender-intelligence.ts", import.meta.url), "utf8");
    assert.match(crawler, /CONTROLLED_CRAWL_ADAPTERS\s*=\s*\["ungm",\s*"cdb",\s*"caricom"\]/);
    assert.match(crawler, /\.set\(\{\s*active:\s*false/);
    assert.match(crawler, /UNDP procurement notices are blocked because robots\.txt/);
    assert.match(crawler, /CARICOM procurement paths are blocked because robots\.txt/);
    assert.match(routes, /getCrawlBlockReason\(current\.adapterType\)/);
    assert.match(routes, /activation_requires_versioned_pilot/);
    assert.match(routes, /versioned, source-specific pilot/);
    assert.match(routes, /requiresControlledPilot\(adapterType\)/);
  });
});
