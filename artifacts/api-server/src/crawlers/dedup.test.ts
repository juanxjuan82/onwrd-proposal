import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crawlerContentFingerprint, normalizeCrawlerUrl } from "./dedup.js";
import { profileMatchesOpportunity } from "./index.js";

describe("crawler identity normalization", () => {
  it("removes tracking/query-order variants and trailing slashes", () => {
    assert.equal(
      normalizeCrawlerUrl("HTTPS://WWW.Example.org/notices/?utm_source=x&b=2&a=1#top"),
      "https://example.org/notices?a=1&b=2",
    );
  });

  it("produces the same fingerprint for equivalent content", () => {
    const first = crawlerContentFingerprint({
      sourceId: 4, title: "  A tender ", organization: "Org",
      description: "A detailed scope", url: "https://example.org/a/",
    });
    const second = crawlerContentFingerprint({
      sourceId: 4, title: "a TENDER", organization: "Org",
      description: "A   detailed scope", url: "https://www.example.org/a?utm_campaign=x",
    });
    assert.equal(first, second);
  });

  it("uses title, organisation, and deadline when descriptions are enriched", () => {
    const first = crawlerContentFingerprint({
      sourceId: 4, title: "A tender", organization: "Org",
      description: "short", deadline: "2027-01-01T00:00:00Z",
    });
    const second = crawlerContentFingerprint({
      sourceId: 4, title: "A tender", organization: "Org",
      description: "a much richer scope", deadline: "2027-01-01T00:00:00Z",
    });
    assert.equal(first, second);
  });
});

describe("persisted crawler search profiles", () => {
  const opportunity = {
    title: "Communications campaign",
    description: "A public awareness campaign for tourism.",
    organization: "Ministry",
  };

  it("matches configured terms and lets exclusions win", () => {
    assert.deepEqual(
      profileMatchesOpportunity(opportunity, [{
        keywords: ["tourism"], excludedKeywords: ["construction"],
      }]),
      { matched: true, excluded: [], matchedKeywords: ["tourism"] },
    );
    assert.equal(profileMatchesOpportunity(
      { ...opportunity, description: "Tourism construction works" },
      [{ keywords: ["tourism"], excludedKeywords: ["construction"] }],
    ).excluded[0], "construction");
  });

  it("does not invent a match for an empty profile", () => {
    assert.equal(profileMatchesOpportunity(opportunity, [{
      keywords: [], excludedKeywords: [],
    }]).matched, false);
  });

  it("treats profiles as alternatives and scopes exclusions", () => {
    const result = profileMatchesOpportunity(opportunity, [
      { keywords: ["tourism"], excludedKeywords: ["campaign"] },
      { keywords: ["communications"], excludedKeywords: [] },
    ]);
    assert.equal(result.matched, true);
  });
});