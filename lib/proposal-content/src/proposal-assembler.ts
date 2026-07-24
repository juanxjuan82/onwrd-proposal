/**
 * Shared proposal assembly utilities.
 * Pure functions — no Node.js or DOM dependencies.
 * Imported by both @workspace/api-server and @workspace/proposal-generator.
 */

/** Minimal section shape accepted by the assembler. Both route responses and DB rows satisfy this. */
export interface SectionLike {
  title: string;
  content: string;
  orderIndex: number;
}

/**
 * Strips a repeated leading Markdown heading from section content.
 *
 * Algorithm:
 *  1. Find the first meaningful (non-blank) line.
 *  2. If that line is a Markdown heading (#, ##, or ###) that matches the
 *     section title case-insensitively — tolerating leading ordinal numbering
 *     such as "1." and trailing punctuation such as ":" — remove exactly that
 *     one line.
 *  3. Never remove more than one heading.
 *  4. Preserve all other content, including internal subheadings (###) and any
 *     leading heading that does NOT match the section title.
 */
export function normalizeSectionBody(title: string, content: string): string {
  const lines = content.split("\n");

  // 1. Find the first meaningful (non-blank) line
  const firstIdx = lines.findIndex((l) => l.trim() !== "");
  if (firstIdx === -1) return content;

  const firstLine = lines[firstIdx];

  // 2. Must be a Markdown heading of level 1–3
  const headingMatch = firstLine.match(/^(#{1,3})\s+(.*)/);
  if (!headingMatch) return content;

  const rawHeadingText = headingMatch[2].trim();

  // Normalise: strip leading ordinal ("1. ", "2) ") and trailing punctuation
  const normalise = (s: string): string =>
    s
      .replace(/^\d+[\.\)]\s*/, "") // leading "1. " or "1) "
      .replace(/[:\.\!\?;,]+$/, "") // trailing punctuation
      .trim();

  // 3. Compare case-insensitively
  if (normalise(rawHeadingText).toLowerCase() !== normalise(title).toLowerCase()) {
    return content; // heading does not match — preserve everything
  }

  // 4. Remove exactly this one line
  const result = [...lines];
  result.splice(firstIdx, 1);
  return result.join("\n");
}

/**
 * Assembles a full proposal document from ordered sections.
 *
 * Each section is prefixed with exactly one `## {title}` heading.
 * The section body is first normalised to remove any duplicate leading heading.
 * Sections are joined with `\n\n---\n\n`.
 */
export function assembleProposalFromSections(sections: SectionLike[]): string {
  return [...sections]
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((s) => `## ${s.title}\n\n${normalizeSectionBody(s.title, s.content)}`)
    .join("\n\n---\n\n");
}
