import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  KNOWLEDGE_MATCH_METHOD,
  buildDeterministicKnowledgeMatchBlock,
  matchRequirementsToKnowledge,
  normalizeKnowledgeText,
} from "./deterministic-knowledge-matching.js";
import type { ApprovedKnowledgeDoc } from "./approved-knowledge.js";

const requirement = {
  id: 7,
  requirementText: "Develop a digital marketing campaign strategy.",
  category: "marketing",
};

function document(
  id: number,
  overrides: Partial<ApprovedKnowledgeDoc> = {},
): ApprovedKnowledgeDoc {
  return {
    id,
    title: "Capability document",
    content: "General agency background.",
    docType: "capability",
    sourceUrl: null,
    tags: "[]",
    isApproved: true,
    ...overrides,
  };
}

describe("deterministic knowledge matching", () => {
  it("normalizes punctuation, accents, case, and whitespace consistently", () => {
    assert.equal(
      normalizeKnowledgeText("  DÍGITAL—Marketing,  Campaign! "),
      "digital marketing campaign",
    );
  });

  it("ranks title matches above content-only matches", () => {
    const matches = matchRequirementsToKnowledge(
      [requirement],
      [
        document(20, {
          title: "Digital Marketing Campaign Strategy",
          content: "Agency services.",
        }),
        document(10, {
          title: "Agency capability",
          content: "Digital marketing campaign strategy programs.",
        }),
      ],
    );
    assert.deepEqual(
      matches[0].sources.map((source) => source.knowledgeDocumentId),
      [20, 10],
    );
    assert.equal(matches[0].status, "matched");
  });

  it("rewards exact phrases, category tags, and normalized plurals", () => {
    const [match] = matchRequirementsToKnowledge(
      [{
        id: 12,
        requirementText: "Deliverables include communications strategies.",
        category: "marketing",
      }],
      [
        document(1, {
          content: "Strategy communications deliverable.",
        }),
        document(2, {
          content: "Communications strategy deliverable.",
          tags: JSON.stringify(["marketing"]),
        }),
      ],
    );
    assert.deepEqual(
      match.sources.map((source) => source.knowledgeDocumentId),
      [2, 1],
    );
    assert.ok(match.sources[0].score > match.sources[1].score);
    assert.deepEqual(
      match.sources[0].matchedTerms,
      ["deliverable", "communication", "strategy"],
    );
  });

  it("uses ascending document ID as a stable tie-break and caps results", () => {
    const matches = matchRequirementsToKnowledge(
      [requirement],
      [
        document(30, { title: "Digital Marketing Campaign Strategy" }),
        document(10, { title: "Digital Marketing Campaign Strategy" }),
        document(20, { title: "Digital Marketing Campaign Strategy" }),
      ],
    );
    assert.deepEqual(
      matches[0].sources.map((source) => source.knowledgeDocumentId),
      [10, 20],
    );
  });

  it("excludes explicitly unapproved documents even when they are the best match", () => {
    const matches = matchRequirementsToKnowledge(
      [requirement],
      [
        document(1, {
          title: "Digital Marketing Campaign Strategy",
          isApproved: false,
        }),
        document(2, {
          content: "Digital marketing campaign strategy delivery.",
        }),
      ],
    );
    assert.deepEqual(
      matches[0].sources.map((source) => source.knowledgeDocumentId),
      [2],
    );
  });

  it("classifies partial and unmatched requirements with explicit scores", () => {
    const [partial] = matchRequirementsToKnowledge(
      [{
        id: 8,
        requirementText:
          "Social media campaign launch measurement reporting governance",
        category: "general",
      }],
      [document(3, { content: "Our social media delivery capability." })],
    );
    const [unmatched] = matchRequirementsToKnowledge(
      [{ id: 9, requirementText: "Provide audited financial statements.", category: "compliance" }],
      [document(4, { content: "Tourism destination brand strategy." })],
    );
    assert.equal(partial.status, "partial");
    assert.ok(partial.score > 0 && partial.score < 60);
    assert.equal(unmatched.status, "unmatched");
    assert.equal(unmatched.score, 0);
    assert.deepEqual(unmatched.sources, []);
  });

  it("preserves source attribution and bounded relevant excerpts", () => {
    const content = `${"Background ".repeat(80)}digital marketing campaign strategy${" Results".repeat(80)}`;
    const [match] = matchRequirementsToKnowledge(
      [requirement],
      [document(4, {
        content,
        sourceUrl: "https://example.com/capability",
      })],
    );
    assert.equal(match.method, KNOWLEDGE_MATCH_METHOD);
    assert.equal(match.sources[0].sourceUrl, "https://example.com/capability");
    assert.match(match.sources[0].excerpt, /digital marketing campaign strategy/i);
    assert.ok(match.sources[0].excerpt.length <= 502);
  });

  it("formats only matched approved sources for the generation context", () => {
    const matches = matchRequirementsToKnowledge(
      [requirement],
      [document(11, { title: "Digital Marketing Campaign Strategy" })],
    );
    const block = buildDeterministicKnowledgeMatchBlock([requirement], matches);
    assert.match(block, /Requirement 1 \[matched; score \d+\]/);
    assert.match(block, /\[Knowledge ID: 11\]/);
  });
});