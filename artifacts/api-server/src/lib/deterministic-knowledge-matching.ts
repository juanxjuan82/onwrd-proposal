import type { ApprovedKnowledgeDoc } from "./approved-knowledge.js";

export const KNOWLEDGE_MATCH_METHOD = "deterministic-token-overlap-v1";
export const KNOWLEDGE_MATCHED_THRESHOLD = 60;
export const KNOWLEDGE_PARTIAL_THRESHOLD = 30;
const MAX_MATCHES_PER_REQUIREMENT = 2;
const MAX_EXCERPT_CHARS = 500;

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has",
  "have", "in", "include", "including", "is", "it", "its", "must", "of", "on",
  "or", "our", "provide", "required", "requirement", "requirements", "shall",
  "should", "that", "the", "their", "this", "to", "using", "we", "will", "with",
]);

export type KnowledgeMatchStatus = "matched" | "partial" | "unmatched";

export interface RequirementForKnowledgeMatch {
  id: number;
  requirementText: string;
  category: string;
}

export interface MatchedKnowledgeSource {
  knowledgeDocumentId: number;
  title: string;
  docType: string;
  sourceUrl: string | null;
  excerpt: string;
  score: number;
  status: Exclude<KnowledgeMatchStatus, "unmatched">;
  matchedTerms: string[];
}

export interface RequirementKnowledgeMatch {
  requirementId: number;
  status: KnowledgeMatchStatus;
  score: number;
  method: typeof KNOWLEDGE_MATCH_METHOD;
  sources: MatchedKnowledgeSource[];
}

export function normalizeKnowledgeText(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function meaningfulTokens(value: string): string[] {
  const canonicalToken = (token: string): string => {
    if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
    if (token.length > 4 && token.endsWith("s") && !token.endsWith("ss")) {
      return token.slice(0, -1);
    }
    return token;
  };
  return [
    ...new Set(
      normalizeKnowledgeText(value)
        .split(" ")
        .filter((token) => token.length >= 3 && !STOP_WORDS.has(token))
        .map(canonicalToken),
    ),
  ];
}

function parseTags(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.filter((tag): tag is string => typeof tag === "string");
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === "string")
      : [];
  } catch {
    return [];
  }
}

function buildRelevantExcerpt(content: string, matchedTerms: string[]): string {
  const normalizedContent = content.toLowerCase();
  const firstMatch = matchedTerms
    .map((term) => normalizedContent.indexOf(term.toLowerCase()))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, firstMatch - 100);
  const raw = content.slice(start, start + MAX_EXCERPT_CHARS).trim();
  return `${start > 0 ? "…" : ""}${raw}${start + MAX_EXCERPT_CHARS < content.length ? "…" : ""}`;
}

function scoreDocument(
  requirement: RequirementForKnowledgeMatch,
  document: ApprovedKnowledgeDoc,
): MatchedKnowledgeSource | null {
  const requirementTokens = meaningfulTokens(requirement.requirementText);
  if (requirementTokens.length === 0) return null;

  const titleTokens = new Set(meaningfulTokens(document.title));
  const parsedTags = parseTags(document.tags);
  const tagTokens = new Set(meaningfulTokens(parsedTags.join(" ")));
  const contentTokens = new Set(meaningfulTokens(document.content));
  const matchedTerms: string[] = [];
  let sourceStrength = 0;

  for (const token of requirementTokens) {
    let strength = 0;
    if (titleTokens.has(token)) strength = 1;
    else if (tagTokens.has(token)) strength = 0.9;
    else if (contentTokens.has(token)) strength = 0.65;
    if (strength > 0) {
      matchedTerms.push(token);
      sourceStrength += strength;
    }
  }
  if (matchedTerms.length === 0) return null;

  const coverage = matchedTerms.length / requirementTokens.length;
  const averageStrength = sourceStrength / matchedTerms.length;
  const categoryTokens = meaningfulTokens(requirement.category);
  const documentTypeTokens = new Set(meaningfulTokens(document.docType));
  const categoryMatches =
    !categoryTokens.includes("general") &&
    categoryTokens.some(
      (token) => documentTypeTokens.has(token) || tagTokens.has(token),
    );
  const documentPhrases = [
    meaningfulTokens(document.title).join(" "),
    meaningfulTokens(parsedTags.join(" ")).join(" "),
    meaningfulTokens(document.content).join(" "),
  ];
  const phraseMatches = requirementTokens
    .slice(0, -1)
    .map((token, index) => `${token} ${requirementTokens[index + 1]}`)
    .filter((phrase) =>
      documentPhrases.some((documentPhrase) => documentPhrase.includes(phrase)),
    ).length;
  const phraseBonus = Math.min(10, phraseMatches * 3);
  const score = Math.min(
    100,
    Math.round(
      coverage * 70 +
      averageStrength * 30 +
      phraseBonus +
      (categoryMatches ? 10 : 0),
    ),
  );
  if (score < KNOWLEDGE_PARTIAL_THRESHOLD) return null;

  return {
    knowledgeDocumentId: document.id,
    title: document.title,
    docType: document.docType,
    sourceUrl: document.sourceUrl ?? null,
    excerpt: buildRelevantExcerpt(document.content, matchedTerms),
    score,
    status: score >= KNOWLEDGE_MATCHED_THRESHOLD ? "matched" : "partial",
    matchedTerms,
  };
}

export function matchRequirementsToKnowledge(
  requirements: RequirementForKnowledgeMatch[],
  documents: ApprovedKnowledgeDoc[],
): RequirementKnowledgeMatch[] {
  const approvedDocuments = documents.filter((document) => document.isApproved !== false);

  return requirements.map((requirement) => {
    const sources = approvedDocuments
      .map((document) => scoreDocument(requirement, document))
      .filter((source): source is MatchedKnowledgeSource => source !== null)
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.knowledgeDocumentId - b.knowledgeDocumentId,
      )
      .slice(0, MAX_MATCHES_PER_REQUIREMENT);
    const score = sources[0]?.score ?? 0;
    return {
      requirementId: requirement.id,
      status:
        score >= KNOWLEDGE_MATCHED_THRESHOLD
          ? "matched"
          : score >= KNOWLEDGE_PARTIAL_THRESHOLD
            ? "partial"
            : "unmatched",
      score,
      method: KNOWLEDGE_MATCH_METHOD,
      sources,
    };
  });
}

export function buildDeterministicKnowledgeMatchBlock(
  requirements: RequirementForKnowledgeMatch[],
  matches: RequirementKnowledgeMatch[],
): string {
  if (requirements.length === 0) return "No extracted requirements are available for matching.";
  const matchesByRequirementId = new Map(
    matches.map((match) => [match.requirementId, match]),
  );
  return requirements
    .map((requirement, index) => {
      const match = matchesByRequirementId.get(requirement.id);
      const sources = match?.sources ?? [];
      return [
        `Requirement ${index + 1} [${match?.status ?? "unmatched"}; score ${match?.score ?? 0}]: ${requirement.requirementText}`,
        sources.length > 0
          ? sources
              .map(
                (source) =>
                  `- [Knowledge ID: ${source.knowledgeDocumentId}] "${source.title}" ` +
                  `(score ${source.score}; terms: ${source.matchedTerms.join(", ")})\n` +
                  source.excerpt,
              )
              .join("\n")
          : "- No approved knowledge matched this requirement.",
      ].join("\n");
    })
    .join("\n\n");
}