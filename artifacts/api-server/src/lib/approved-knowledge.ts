/**
 * Approved-knowledge allowlist for proposal credentials.
 *
 * Replaces the static ONWRD_CASE_STUDIES constant: the credential allowlist
 * is now retrieved live from the knowledge_documents table (isApproved=true
 * only). Case-study documents are injected with content; other approved
 * documents contribute their exact titles to the allowlist.
 *
 * Also provides the post-generation credential validator that flags any
 * organisation name cited in the credentials section that is not on the
 * approved-title allowlist (unverifiedCredentials → reviewRequired).
 */

import { db, knowledgeDocumentsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export interface ApprovedKnowledgeDoc {
  id: number;
  title: string;
  content: string;
  docType: string;
  sourceUrl?: string | null;
  tags?: string | string[];
  /** Present on DB results; optional for backwards-compatible pure fixtures. */
  isApproved?: boolean;
}

/** Fetch ONLY isApproved=true knowledge documents. */
export async function getApprovedKnowledge(): Promise<ApprovedKnowledgeDoc[]> {
  return db
    .select({
      id: knowledgeDocumentsTable.id,
      title: knowledgeDocumentsTable.title,
      content: knowledgeDocumentsTable.content,
      docType: knowledgeDocumentsTable.docType,
      sourceUrl: knowledgeDocumentsTable.sourceUrl,
      tags: knowledgeDocumentsTable.tags,
      isApproved: knowledgeDocumentsTable.isApproved,
    })
    .from(knowledgeDocumentsTable)
    .where(eq(knowledgeDocumentsTable.isApproved, true));
}

const CASE_STUDY_CONTENT_CHARS = 1500;

/**
 * Build the prompt block: an explicit allowlist of exact titles, with
 * content excerpts for case-study documents. When the approved set is
 * empty, instructs the model to emit the [NEEDS ONWRD INPUT] placeholder.
 */
export function buildKnowledgeBlock(
  docs: ApprovedKnowledgeDoc[],
  excerptKnowledgeIds?: ReadonlySet<number>,
): string {
  if (docs.length === 0) {
    return `ONWRD APPROVED CREDENTIALS ALLOWLIST: EMPTY

There are NO approved ONWRD case studies or credentials available.
- You MUST NOT name any past client, project, or engagement.
- In the Case Studies and Credentials section, write exactly:
  [NEEDS ONWRD INPUT: relevant case study]
- Never invent, recall, or infer ONWRD clients from any other source.`;
  }

  const caseStudies = docs.filter((d) => d.docType === "case_study");
  const others = docs.filter((d) => d.docType !== "case_study");

  const caseStudyBlock = caseStudies
    .map(
      (d, i) =>
        `${i + 1}. [Knowledge ID: ${d.id}] "${d.title}"` +
        (
          !excerptKnowledgeIds || excerptKnowledgeIds.has(d.id)
            ? `\n${d.content.slice(0, CASE_STUDY_CONTENT_CHARS)}`
            : ""
        ),
    )
    .join("\n\n");

  return `ONWRD APPROVED CREDENTIALS ALLOWLIST (from the Knowledge Library — the ONLY permitted sources of ONWRD credentials):

APPROVED CASE STUDIES (cite ONLY these, using their EXACT titles verbatim):
${caseStudyBlock || "(none)"}

OTHER APPROVED KNOWLEDGE TITLES (background/capability material; may inform tone and approach but are NOT client credentials):
  ${others.map((d) => `- [Knowledge ID: ${d.id}] "${d.title}"`).join("\n") || "(none)"}

CREDENTIAL CITATION RULES (STRICT):
- The Case Studies and Credentials section may cite ONLY the approved case studies above, and MUST use their exact titles verbatim — do not rename, paraphrase, or "improve" a client name.
- If none of the approved case studies is relevant to this brief, write [NEEDS ONWRD INPUT: relevant case study] instead. NEVER invent a client, project, metric, or outcome.
- Do NOT cite any organisation as ONWRD past work unless its exact title appears in the approved case-study list — not from memory, not from the tender text, not from general knowledge.`;
}

// ── Post-generation credential validation ────────────────────────────────────

// "for"/"and" are NOT connectors: "Design for X" and "A and B" must split so
// service words and org names are evaluated separately.
const CONNECTORS = new Set(["of", "the", "de", "du", "la", "&"]);

/** Generic capitalized-phrase leads that are prose, not org names. */
const GENERIC_LEADS = new Set([
  "our", "the", "this", "these", "those", "we", "in", "as", "by", "for",
  "case", "why", "what", "how", "with", "a", "an", "each", "every", "all",
  "relevant", "similar", "key", "client", "project", "engagement",
]);

/** Common business/marketing acronyms and capitalised prose terms that are not client names. */
const NON_ORG_SINGLE_TOKENS = new Set([
  // acronyms / initialisms common in proposals
  "kpi", "kpis", "rfp", "rfps", "rfq", "rfi", "usd", "bsd", "roi", "seo", "sem",
  "ai", "esg", "ngo", "ngos", "it", "pr", "ceo", "cmo", "cfo", "coo", "cto",
  "faq", "faqs", "crm", "ugc", "b2b", "b2c", "us", "uk", "eu", "un", "ux", "ui",
  "csr", "gdp", "vat", "sla", "sow", "poc", "hr", "llc", "ltd", "inc", "co",
  "q1", "q2", "q3", "q4", "tbd", "tbc", "na", "id", "ip", "api", "url", "pdf",
  // months / days
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  // nationalities / languages / regional adjectives common in this domain
  "bahamian", "bahamians", "caribbean", "english", "spanish", "french",
  "haitian", "american", "british", "canadian",
]);

const DEFAULT_ALLOWED = [
  "ONWRD",
  "ONWRD Advisors",
  "The Bahamas",
  "Bahamas",
  "Caribbean",
  "Nassau",
  "Grand Bahama",
  "New Providence",
  "Latin America",
  "United States",
  "Case Studies",
  "Case Studies and Credentials",
  "Credentials",
  "Needs Onwrd Input",
];

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SERVICE_WORDS = new Set([
  "marketing", "strategy", "strategies", "brand", "branding", "design",
  "visual", "digital", "campaign", "campaigns", "content", "media",
  "communications", "communication", "creative", "development", "website",
  "websites", "social", "advertising", "launch", "plan", "planning", "report",
  "reporting", "audit", "analytics", "workshop", "workshops", "training",
  "identity", "production", "storytelling", "engagement", "awareness",
  "series", "program", "programme", "initiative", "roadmap", "framework",
  "deliverable", "deliverables", "proposal", "proposals", "executive",
  "summary", "approach", "timeline", "investment", "pricing", "methodology",
  "scope", "phase", "phases", "overview", "objectives", "results", "impact",
  "activation", "activations", "rebrand", "redesign", "refresh", "toolkit",
  "guidelines", "positioning", "messaging", "outreach", "management",
  "consulting", "advisory", "research", "insights", "services",
]);

/** Verbs that mark a sentence-lead capitalized word as a cited client ("Disney was a client"). */
const CREDENTIAL_VERBS = new Set([
  "was", "is", "were", "are", "has", "had", "have", "engaged", "partnered",
  "hired", "retained", "selected", "chose", "trusted", "commissioned",
  "appointed", "contracted", "worked", "benefited", "launched", "relied",
  "turned", "came", "approached", "asked", "needed", "wanted", "saw",
  "achieved", "experienced", "received", "enjoyed", "entrusted", "tapped",
]);

/**
 * Extract candidate organisation names from credential prose.
 *
 * Design (task #64 review feedback):
 *  - Punctuation is preserved as phrase boundaries: commas, semicolons,
 *    colons, and sentence ends terminate a candidate phrase, so
 *    "Marketing Strategy, Brand Visual Strategy" never merges across the
 *    comma into one pseudo-organisation.
 *  - Title-cased SERVICE phrases ("Marketing Strategy", "Brand Visual
 *    Strategy and Design") are not organisations and are never emitted.
 *  - Single capitalized words ARE candidates when they appear in credential
 *    structure: mid-sentence ("for Acme"), followed by a credential verb at
 *    sentence start ("Disney was an ONWRD client."), as a heading or list
 *    label ("## Disney", "- Disney: rebrand"), or as ALL-CAPS acronyms
 *    (UNICEF) anywhere.
 */
export function extractOrgCandidates(text: string): string[] {
  const candidates = new Set<string>();

  // Newlines are hard boundaries; strip markdown formatting chars per line.
  for (const line of text.split(/\n+/)) {
    const plain = line.replace(/[#*_`>\[\]]/g, " ");
    const tokens = plain.split(/\s+/).filter(Boolean);
    const soloLine = tokens.length === 1;
    let current: string[] = [];
    let capCount = 0;
    let sentenceStart = true;
    let phraseStartedMidSentence = false;

    const stripNorm = (w: string) =>
      w.toLowerCase().replace(/['’]s$/, "").replace(/[^a-z0-9]/g, "");

    const flush = (nextLower: string | null, labelLike: boolean) => {
      while (current.length && CONNECTORS.has(current[current.length - 1].toLowerCase())) {
        current.pop();
      }
      capCount = current.filter((w) => /^[A-Z]/.test(w)).length;
      if (current.length > 0) {
        const nonConnector = current.filter((w) => !CONNECTORS.has(w.toLowerCase()));
        // Title-cased service/business phrases are not organisations.
        const allService = nonConnector.every((w) => {
          const n = stripNorm(w);
          return SERVICE_WORDS.has(n) || NON_ORG_SINGLE_TOKENS.has(n);
        });
        if (!allService) {
          const lead = stripNorm(current[0]);
          if (current.length >= 2 && capCount >= 2) {
            if (!GENERIC_LEADS.has(lead)) candidates.add(current.join(" "));
          } else if (current.length === 1 && capCount === 1) {
            const word = current[0];
            const norm = stripNorm(word);
            const isAcronym =
              /^[A-Z][A-Z0-9&.-]+$/.test(word) && word.replace(/[^A-Z]/g, "").length >= 2;
            const inCredentialStructure =
              isAcronym ||
              phraseStartedMidSentence ||
              labelLike ||
              soloLine ||
              (nextLower !== null && CREDENTIAL_VERBS.has(nextLower));
            if (
              inCredentialStructure &&
              norm.length >= 2 &&
              !NON_ORG_SINGLE_TOKENS.has(norm) &&
              !GENERIC_LEADS.has(norm) &&
              !CONNECTORS.has(norm) &&
              !SERVICE_WORDS.has(norm)
            ) {
              candidates.add(word);
            }
          }
        }
      }
      current = [];
      capCount = 0;
      phraseStartedMidSentence = false;
    };

    for (const raw of tokens) {
      const word = raw.replace(/^[("'']+/, "").replace(/[)"'',;:!?—–-]+$/g, "").replace(/\.+$/, "");
      const endsSentence = /[.!?]['")]*$/.test(raw);
      // Commas/semicolons/colons/dashes are phrase boundaries.
      const endsClause = /[,;:—–-]['")]*$/.test(raw);
      const isCap = /^[A-Z][A-Za-z0-9&'’.-]*$/.test(word) && word.length > 1;
      const isConnector = CONNECTORS.has(word.toLowerCase());
      if (isCap) {
        if (current.length === 0) phraseStartedMidSentence = !sentenceStart;
        current.push(word);
        capCount++;
      } else if (isConnector && current.length > 0) {
        current.push(word);
      } else {
        flush(word.toLowerCase() || null, false);
      }
      if (endsSentence) {
        flush(null, false);
      } else if (endsClause) {
        // "Disney:" / "Disney —" is a label introducing its own description.
        flush(null, /[:—–-]['")]*$/.test(raw));
      }
      sentenceStart = endsSentence || endsClause;
    }
    flush(null, false);
  }
  return [...candidates];
}

/**
 * Return organisation names cited in the credentials section that are not
 * exactly matched by the approved-title allowlist (or the extra allowed terms —
 * e.g. the tender's own agency, which a proposal legitimately names).
 */
export function scanUnverifiedCredentials(
  sectionContent: string,
  approvedTitles: string[],
  extraAllowed: string[] = [],
): string[] {
  const allowed = [...approvedTitles, ...extraAllowed, ...DEFAULT_ALLOWED]
    .map(normalize)
    .filter(Boolean);
  const isAllowed = (candidate: string): boolean => {
    const c = normalize(candidate);
    if (!c) return true;
    // A credential must cite the complete approved title. `normalize` permits
    // harmless formatting/case differences but never a partial or renamed
    // title such as "Templeton Religion" for "Templeton Religion Trust".
    return allowed.some((a) => a === c);
  };
  return extractOrgCandidates(sectionContent).filter((name) => !isAllowed(name));
}

/**
 * Extract the "Case Studies" / credentials portion of a whole proposal
 * document. Supports Markdown/bold headings and the numbered plain-text
 * headings used by the canonical proposal template. Returns null when no such
 * section heading exists. Captures until the next comparable section boundary
 * or divider.
 */
export function extractCaseStudiesPortion(markdown: string): string | null {
  const lines = markdown.split("\n");
  type SectionHeading = {
    kind: "markdown" | "bold" | "numbered";
    level: number;
  };
  const getHeading = (l: string): SectionHeading | null => {
    const m = /^\s{0,3}(#{1,6})\s+\S/.exec(l);
    if (m) return { kind: "markdown", level: m[1].length };
    if (/^\s*\*\*[^*]+\*\*:?\s*$/.test(l)) {
      return { kind: "bold", level: 7 };
    }
    // Top-level numbered headers from PROPOSAL_TEMPLATE: "13. CASE STUDIES
    // AND CREDENTIALS". Deliberately excludes subclauses such as "14.1
    // Confidentiality", which belong to the following top-level section.
    if (/^\s*\d+\.\s+[A-Z][A-Z0-9 \t&/–—'():,.-]*\s*$/.test(l)) {
      return { kind: "numbered", level: 1 };
    }
    return null;
  };
  const isCaseStudiesHeading = (l: string) =>
    /case\s+stud|credential|past\s+(work|client)|track\s+record/i.test(l);
  // Bold pseudo-headings have no inherent hierarchy. These are proposal
  // section labels rather than client-style bold subheadings, so they end a
  // bold credentials section; `**World Central Kitchen**` does not.
  const isLikelyTopLevelSection = (l: string) =>
    /\b(executive\s+summary|project\s+overview|our\s+approach|scope|deliverable|timeline|investment|pricing|why\s+onwrd|legal|terms|team|next\s+steps)\b/i.test(l);

  const out: string[] = [];
  let capturing = false;
  let found = false;
  let sectionLevel = 0;
  let sectionKind: SectionHeading["kind"] | null = null;

  for (const line of lines) {
    const heading = getHeading(line);
    if (heading) {
      const isBoundary = (() => {
        if (!capturing) return false;
        // A top-level numbered header always begins the next template section.
        if (heading.kind === "numbered") return true;
        // In a numbered credentials section, Markdown/bold headings are
        // subordinate content unless another numbered section starts.
        if (sectionKind === "numbered") return false;
        if (sectionKind === "bold") {
          // `### Client Name` and `**Client Name**` are normal ways to name
          // credentials beneath a bold section header. Markdown H1/H2 and
          // recognizable proposal section labels are genuine boundaries.
          return (
            (heading.kind === "markdown" && heading.level <= 2) ||
            (heading.kind === "bold" && isLikelyTopLevelSection(line))
          );
        }
        // Markdown credentials headings preserve normal heading hierarchy.
        return (
          (heading.kind === "bold" && isLikelyTopLevelSection(line)) ||
          heading.level <= sectionLevel
        );
      })();
      if (isBoundary) {
        // Same-or-shallower Markdown/bold headings, and all following
        // top-level numbered template headings, end the credentials section.
        capturing = false;
      }
      if (!capturing && isCaseStudiesHeading(line)) {
        capturing = true;
        found = true;
        sectionLevel = heading.level;
        sectionKind = heading.kind;
        continue;
      }
      // …but subordinate headings inside the section are CONTENT: proposals
      // routinely name each cited client as its own sub-heading, so those
      // lines must be scanned too.
      if (capturing) out.push(line);
      continue;
    }
    if (capturing && /^\s*---+\s*$/.test(line)) {
      capturing = false;
      continue;
    }
    if (capturing) out.push(line);
  }
  return found ? out.join("\n") : null;
}

/**
 * Whole-document credential scan: locate the Case Studies portion of a
 * complete proposal document and scan it against the approved allowlist.
 * No credentials section → nothing cited → no unverified credentials.
 */
export function scanDocumentCredentials(
  markdown: string,
  approvedTitles: string[],
  extraAllowed: string[] = [],
): string[] {
  const portion = extractCaseStudiesPortion(markdown);
  if (!portion) return [];
  return scanUnverifiedCredentials(portion, approvedTitles, extraAllowed);
}

/** Titles of approved case-study documents — the only citable credentials. */
export async function getCaseStudyTitles(): Promise<string[]> {
  return (await getApprovedKnowledge())
    .filter((d) => d.docType === "case_study")
    .map((d) => d.title);
}
