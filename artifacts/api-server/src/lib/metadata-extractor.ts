/**
 * Deterministic metadata extractor for raw tender / RFP document text.
 * No AI calls — regex patterns and heuristics only.
 *
 * Callers should surface needsReview=true fields as blank/editable in the UI
 * rather than silently filling them.
 */

export interface ExtractedTenderMetadata {
  title:        string | null;
  agency:       string | null;
  description:  string;
  category:     string;
  deadline:     string | null;   // ISO date (YYYY-MM-DD) or null
  valueAmount:  string | null;
  contactInfo:  string | null;
  /**
   * true when title or agency could not be extracted with confidence —
   * the caller should prompt the user to review / correct the fields.
   */
  needsReview:  boolean;
}

// ── Title ─────────────────────────────────────────────────────────────────────

const TITLE_LABEL_RE = /^(?:subject|title|re|rfp|project|tender)\s*[:–\-]\s*(.+)$/i;
const HEADING_RE     = /^#{1,3}\s+(.+)$/;
const ALL_CAPS_RE    = /^[A-Z0-9 ,&():/'"\-]+$/;

function extractTitle(text: string): string | null {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  // 1. Labelled line — "Title: ...", "Subject: ...", "RFP: ..."
  for (const line of lines.slice(0, 30)) {
    const m = line.match(TITLE_LABEL_RE);
    if (m?.[1]) return m[1].trim().slice(0, 200);
  }

  // 2. Markdown heading
  for (const line of lines.slice(0, 20)) {
    const m = line.match(HEADING_RE);
    if (m?.[1]) return m[1].trim().slice(0, 200);
  }

  // 3. ALL-CAPS line (typical in official procurement docs)
  for (const line of lines.slice(0, 20)) {
    if (line.length >= 10 && line.length <= 200 && ALL_CAPS_RE.test(line)) {
      return line.slice(0, 200);
    }
  }

  // 4. First short non-empty line
  for (const line of lines.slice(0, 10)) {
    if (line.length >= 8 && line.length <= 150) return line.slice(0, 200);
  }

  return null;
}

// ── Agency ───────────────────────────────────────────────────────────────────

const AGENCY_LABEL_RE = /(?:issued\s+by|contracting\s+authority|procuring\s+entity|client\s*:|organisation\s*:|organization\s*:|issuing\s+(?:organization|organisation|authority|agency)|requesting\s+agency|prepared\s+for|submitted\s+to|from\s*:)\s*(.{5,150})/i;

const ORG_PREFIX_RE = /(?:Ministry|Department|Office|Government|Authority|Agency|Bureau|Division|Council|Commission|Board|Institute|University|College|Hospital|Bank|Fund|Programme|Program|Corporation|Company)\s+of\b[^.\n]{0,80}/i;

function extractAgency(text: string): string | null {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  // 1. Labelled line
  for (const line of lines.slice(0, 60)) {
    const m = line.match(AGENCY_LABEL_RE);
    if (m?.[1]) {
      const candidate = m[1].trim().replace(/[,:;]$/, "").slice(0, 150);
      if (candidate.length >= 4) return candidate;
    }
  }

  // 2. Lines starting with known org-type prefixes
  for (const line of lines.slice(0, 60)) {
    const m = line.match(ORG_PREFIX_RE);
    if (m) return m[0].trim().slice(0, 150);
  }

  return null;
}

// ── Deadline ──────────────────────────────────────────────────────────────────

const DEADLINE_LABEL_RE = /\b(?:deadline|closing\s+date|closing\s+time|submission\s+deadline|submission\s+date|due\s+date|proposals?\s+due|bids?\s+due|responses?\s+due|received\s+by|no\s+later\s+than|not\s+later\s+than)\b/i;

const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
const DATE_RE_ISO  = /\b(\d{4}-\d{2}-\d{2})\b/;
const DATE_RE_DMY  = new RegExp(`\\b(\\d{1,2})\\s+(${MONTHS})\\s+(\\d{4})\\b`, "i");
const DATE_RE_MDY  = new RegExp(`\\b(${MONTHS})\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, "i");
const DATE_RE_SLASH = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/;

function toIso(d: Date): string | null {
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split("T")[0];
}

function parseDate(fragment: string): string | null {
  let m: RegExpMatchArray | null;

  m = fragment.match(DATE_RE_ISO);
  if (m) return toIso(new Date(m[1]));

  m = fragment.match(DATE_RE_DMY);
  if (m) return toIso(new Date(`${m[2]} ${m[1]} ${m[3]}`));

  m = fragment.match(DATE_RE_MDY);
  if (m) return toIso(new Date(`${m[1]} ${m[2]} ${m[3]}`));

  m = fragment.match(DATE_RE_SLASH);
  if (m) {
    const d = new Date(`${m[1]}/${m[2]}/${m[3]}`);
    return toIso(d);
  }

  return null;
}

function extractDeadline(text: string): string | null {
  // 1. Search a 250-char window after deadline-label keywords
  const pattern = new RegExp(DEADLINE_LABEL_RE.source, "gi");
  for (const m of text.matchAll(pattern)) {
    const idx = m.index ?? 0;
    const window = text.slice(idx, idx + 250);
    const d = parseDate(window);
    if (d) return d;
  }

  // 2. Scan all lines for date-like patterns (less confident)
  for (const line of text.split("\n")) {
    const d = parseDate(line);
    if (d) return d;
  }

  return null;
}

// ── Value amount ──────────────────────────────────────────────────────────────

const VALUE_LABEL_RE  = /\b(?:budget|contract\s+value|estimated\s+(?:value|cost|budget)|total\s+(?:value|cost|budget)|amount|estimated\s+fee|contract\s+amount|award\s+value)\b/i;
const VALUE_AMOUNT_RE = /(?:USD?|BSD?|B\$|\$|€|£|XCD|CAD)\s*[\d,]+(?:\.\d+)?(?:\s*(?:million|m\b|k\b|thousand))?|\b[\d,]+(?:\.\d+)?\s*(?:million|m\b|k\b)?\s*(?:USD?|BSD?|dollars?)/i;

function extractValue(text: string): string | null {
  const pattern = new RegExp(VALUE_LABEL_RE.source, "gi");
  for (const m of text.matchAll(pattern)) {
    const idx = m.index ?? 0;
    const window = text.slice(idx, idx + 200);
    const v = window.match(VALUE_AMOUNT_RE);
    if (v) return v[0].trim().slice(0, 100);
  }
  return null;
}

// ── Contact info ──────────────────────────────────────────────────────────────

const EMAIL_RE = /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/;
const PHONE_RE = /(?:\+\d{1,3}[\s\-])?\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/;

function extractContact(text: string): string | null {
  const parts: string[] = [];
  const email = text.match(EMAIL_RE);
  if (email) parts.push(email[0]);
  const phone = text.match(PHONE_RE);
  if (phone) parts.push(phone[0].trim());
  return parts.length > 0 ? parts.join(" | ").slice(0, 200) : null;
}

// ── Category ──────────────────────────────────────────────────────────────────

const CATEGORIES: Array<{ category: string; terms: string[] }> = [
  { category: "Marketing",            terms: ["marketing", "advertising", "promotion", "media campaign"] },
  { category: "Communications",       terms: ["communications strategy", "stakeholder communications", "public relations", "pr campaign", "comms"] },
  { category: "Branding",             terms: ["branding", "brand identity", "rebranding", "brand strategy"] },
  { category: "Digital",              terms: ["digital marketing", "social media", "digital communications", "web design", "seo", "online campaign"] },
  { category: "Tourism",              terms: ["tourism", "destination marketing", "hospitality", "visitor economy"] },
  { category: "Community Engagement", terms: ["community engagement", "behavior change", "awareness campaign", "outreach", "sensitization", "social mobilization"] },
  { category: "Research",             terms: ["research", "assessment", "evaluation", "survey", "feasibility study"] },
  { category: "IT",                   terms: ["software", "it services", "information technology", "system development", "database", "application development"] },
  { category: "Construction",         terms: ["construction", "civil works", "infrastructure", "road works", "bridge"] },
  { category: "Consulting",           terms: ["consulting", "advisory", "strategic planning", "management consulting"] },
];

function extractCategory(text: string): string {
  const lower = text.toLowerCase();
  for (const { category, terms } of CATEGORIES) {
    if (terms.some((t) => lower.includes(t))) return category;
  }
  return "General";
}

// ── Description ───────────────────────────────────────────────────────────────

function extractDescription(text: string): string {
  const meaningful = text
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t.length > 0 && t.split(/\s+/).length >= 5;
    })
    .join(" ");

  return (meaningful || text).slice(0, 1000).trim();
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Extract tender metadata from raw document text without any AI calls.
 *
 * Fields that cannot be determined reliably are returned as null.
 * When needsReview is true, the caller should display an editable form
 * so the user can correct the extracted values before saving.
 */
export function extractTenderMetadata(text: string): ExtractedTenderMetadata {
  const title       = extractTitle(text);
  const agency      = extractAgency(text);
  const deadline    = extractDeadline(text);
  const valueAmount = extractValue(text);
  const contactInfo = extractContact(text);
  const category    = extractCategory(text);
  const description = extractDescription(text);
  const needsReview = !title || !agency;

  return {
    title,
    agency,
    description,
    category,
    deadline,
    valueAmount,
    contactInfo,
    needsReview,
  };
}
