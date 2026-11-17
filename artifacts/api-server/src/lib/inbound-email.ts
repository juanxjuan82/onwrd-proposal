/**
 * Email forwarding → Opportunity.
 *
 * A team member (or a mail rule) forwards a tender alert to the app's
 * forwarding address. The email provider (Resend Inbound) notifies the app by
 * webhook; the app then fetches the email, and turns it into ONE opportunity
 * for human review — the same outcome as pasting it into "Add tender".
 *
 * Deliberately conservative:
 *  - No AI. Metadata comes from the deterministic extractor.
 *  - Only approved senders are accepted; everything else is logged and dropped.
 *  - Email content is untrusted: it is scanned for prompt-injection and never
 *    interpreted as instructions.
 *  - Links inside the email are NOT followed. Many tender sites disallow
 *    crawlers; a forwarded email is not permission to crawl them.
 */
import { ALLOWED_EMAIL_DOMAIN } from "./allowed-domain.js";
import { extractTenderMetadata } from "./metadata-extractor.js";
import { computeInjectionWarning } from "./prompt-safety.js";

export const MAX_ATTACHMENTS = 3;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_RAW_TEXT_CHARS = 400_000;
const MIN_USEFUL_CHARS = 50;

export interface InboundEmailContent {
  id: string;
  from: string;
  to: string[];
  receivedFor?: string[];
  subject: string;
  text: string | null;
  html: string | null;
  messageId?: string | null;
}

export interface InboundAttachmentText {
  filename: string;
  text: string;
}

export interface InboundEmailConfig {
  /** Extra approved senders: full addresses or bare domains, lower-case. */
  allowedSenders: string[];
  /** When set, the email must have been delivered to this address. */
  forwardingAddress: string | null;
}

/** Read forwarding settings from the environment. */
export function readInboundEmailConfig(env: NodeJS.ProcessEnv = process.env): InboundEmailConfig {
  const allowedSenders = (env.INBOUND_EMAIL_ALLOWED_SENDERS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
  const forwardingAddress = env.INBOUND_EMAIL_ADDRESS?.trim().toLowerCase() || null;
  return { allowedSenders, forwardingAddress };
}

/** "Jane Doe <jane@example.com>" → "jane@example.com" (lower-case), or null. */
export function parseEmailAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  const angle = value.match(/<([^<>\s]+@[^<>\s]+)>\s*$/);
  const candidate = (angle ? angle[1] : value).trim().toLowerCase();
  return /^[^\s@<>"]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(candidate) ? candidate : null;
}

/**
 * A sender is approved when it is on the company domain, or matches an entry
 * in INBOUND_EMAIL_ALLOWED_SENDERS (exact address, or domain incl. subdomains).
 */
export function isSenderAllowed(from: string | null | undefined, config: InboundEmailConfig): boolean {
  const address = parseEmailAddress(from);
  if (!address) return false;
  const domain = address.slice(address.lastIndexOf("@") + 1);
  if (domain === ALLOWED_EMAIL_DOMAIN) return true;
  return config.allowedSenders.some((entry) =>
    entry.includes("@")
      ? entry === address
      : domain === entry || domain.endsWith(`.${entry}`));
}

export function isRecipientAccepted(email: Pick<InboundEmailContent, "to" | "receivedFor">, config: InboundEmailConfig): boolean {
  if (!config.forwardingAddress) return true;
  const recipients = [...(email.receivedFor ?? []), ...email.to]
    .map((value) => parseEmailAddress(value))
    .filter((value): value is string => Boolean(value));
  return recipients.includes(config.forwardingAddress);
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", nbsp: " ", quot: '"', apos: "'", ndash: "–", mdash: "—",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…",
};

/** Convert an HTML email body to readable plain text (links kept as "text (url)"). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<a\b[^>]*href=(["'])(https?:\/\/[^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi, "$3 ($2) ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => safeChar(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (_m, name: string) => ENTITIES[name.toLowerCase()] ?? " ")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safeChar(code: number): string {
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
}

/** Prefer the plain-text part; fall back to the HTML part converted to text. */
export function emailBodyText(email: Pick<InboundEmailContent, "text" | "html">): string {
  const plain = (email.text ?? "").replace(/\r\n/g, "\n").trim();
  if (plain.length >= MIN_USEFUL_CHARS) return plain;
  const fromHtml = email.html ? htmlToText(email.html) : "";
  return fromHtml.length > plain.length ? fromHtml : plain;
}

/** "Fwd: FW: RE: Tender notice" → "Tender notice" */
export function cleanSubject(subject: string): string {
  let cleaned = subject.trim();
  for (let i = 0; i < 6; i++) {
    const next = cleaned.replace(/^\s*(?:fwd?|fw|re|tr|wg)\s*:\s*/i, "").replace(/^\s*\[[^\]]{1,30}\]\s*/, "");
    if (next === cleaned) break;
    cleaned = next;
  }
  return cleaned.replace(/\s+/g, " ").trim();
}

/** First ordinary web link in the text — a convenience for the reviewer only. */
export function firstUsefulLink(text: string): string | null {
  const links = text.match(/https:\/\/[^\s<>()"'\]]+/gi) ?? [];
  for (const raw of links) {
    const link = raw.replace(/[.,;:!?]+$/, "");
    if (/unsubscribe|preferences|optout|opt-out|mailchi\.mp|list-manage|google\.com\/mail|tracking|click\./i.test(link)) continue;
    try {
      const url = new URL(link);
      if (url.hostname.includes(".")) return url.toString().slice(0, 500);
    } catch { /* not a usable link */ }
  }
  return null;
}

export interface TenderDraftFromEmail {
  title: string;
  agency: string;
  description: string;
  category: string;
  deadline: Date | null;
  valueAmount: string | null;
  sourceUrl: string | null;
  contactInfo: string | null;
  rawText: string;
  injectionWarning: boolean;
}

export type BuildResult =
  | { ok: true; draft: TenderDraftFromEmail }
  | { ok: false; reason: string };

/** Turn a forwarded email (+ any text read from attachments) into a tender draft. */
export function buildTenderFromEmail(
  email: InboundEmailContent,
  attachments: InboundAttachmentText[] = [],
): BuildResult {
  const body = emailBodyText(email);
  const attachmentText = attachments
    .filter((attachment) => attachment.text.trim().length > 0)
    .map((attachment) => `[Attachment: ${attachment.filename}]\n${attachment.text.trim()}`)
    .join("\n\n");
  const content = [body, attachmentText].filter(Boolean).join("\n\n");
  if (content.replace(/\s+/g, " ").trim().length < MIN_USEFUL_CHARS) {
    return { ok: false, reason: "The email had no readable text or attachments." };
  }

  const subject = cleanSubject(email.subject ?? "");
  const sender = parseEmailAddress(email.from) ?? "unknown sender";
  const rawText = (
    `Forwarded by email from ${sender}\nSubject: ${subject || "(no subject)"}\n\n${content}`
  ).slice(0, MAX_RAW_TEXT_CHARS);

  // The attached document (if any) is usually the real tender; the email body
  // is often just "see attached". Feed the richer text to the extractor.
  const primary = attachmentText.length > body.length ? attachmentText : content;
  const meta = extractTenderMetadata(primary.slice(0, 8000));

  // A forwarded alert's subject line is normally the tender's own title.
  const title = (subject.length >= 8 ? subject : meta.title ?? subject) ||
    "Needs review — title not detected";
  const agency = meta.agency ?? "Needs review — agency not detected";
  const sourceUrl = firstUsefulLink(body);
  const deadline = meta.deadline ? new Date(meta.deadline) : null;

  return {
    ok: true,
    draft: {
      title: title.slice(0, 200),
      agency: agency.slice(0, 150),
      description: (meta.description || content.slice(0, 500)).slice(0, 2000),
      category: meta.category,
      deadline: deadline && !Number.isNaN(deadline.getTime()) ? deadline : null,
      valueAmount: meta.valueAmount ?? null,
      sourceUrl,
      contactInfo: meta.contactInfo ?? null,
      rawText,
      // Everything derived from the email is untrusted input.
      injectionWarning: computeInjectionWarning(
        title, agency, meta.contactInfo, sourceUrl, rawText,
      ),
    },
  };
}

/** Which attachments are worth reading, in order, within the limits. */
export function selectReadableAttachments<T extends { filename?: string | null; size: number; content_type?: string }>(
  attachments: readonly T[],
): T[] {
  return attachments
    .filter((attachment) => {
      const name = (attachment.filename ?? "").toLowerCase();
      const type = (attachment.content_type ?? "").toLowerCase();
      const readable = /\.(pdf|docx|txt)$/.test(name) ||
        type === "application/pdf" || type === "text/plain" ||
        type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      return readable && attachment.size > 0 && attachment.size <= MAX_ATTACHMENT_BYTES;
    })
    .slice(0, MAX_ATTACHMENTS);
}
