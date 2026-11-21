import { Resend } from "resend";
import { stableExternalId } from "./dedup.js";
import {
  AdapterFetchContext,
  TenderOpportunity,
  TenderSourceAdapter,
  stripHtml,
} from "./base-adapter.js";
import { decodeEntities, readListingDeadline } from "./listing-adapter.js";

// Email-alert source.
//
// Several tender portals forbid crawlers but will email new tenders to a
// registered address (UN Global Marketplace, the Cayman and Bahamas Bonfire
// portals, Jamaica's GOJEP, the IDB, MERX). Those alerts are sent — or
// forwarded — to the app's receiving mailbox at Resend (the same service that
// sends the digest), and this adapter turns each alert into leads.
//
// Safety: only mail from an approved sender is read; links are stored for a
// person to open and are never fetched by the server.

export interface AlertEmail {
  id: string;
  from: string;
  subject: string;
  receivedAt?: Date;
  html?: string | null;
  text?: string | null;
}

export interface AlertLead {
  title: string;
  url?: string;
  context: string;
  deadline?: Date;
}

/** Tender platforms whose alert emails are accepted without extra setup. */
export const DEFAULT_ALERT_SENDER_DOMAINS = [
  "ungm.org", "un.org", "undp.org", "unicef.org", "paho.org",
  "bonfirehub.com", "gobonfire.com", "euna.com",
  "gojep.gov.jm", "iadb.org", "merx.com", "canada.ca", "worldbank.org",
  "caribank.org", "oecs.int", "oecs.org",
] as const;

const LOOKBACK_DAYS = 14;
const MAX_EMAILS_PER_RUN = 40;
const MAX_LEADS_PER_EMAIL = 15;
const MAX_LEADS_PER_RUN = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

// Links every alert email carries that are not tenders.
const BOILERPLATE_LINK = /\b(?:unsubscribe|subscription|preferences|manage (?:your )?(?:alerts?|notifications?|account)|view (?:this )?(?:email )?in (?:your )?browser|privacy|terms (?:of|and)|contact us|help( cent(?:er|re))?|log ?in|sign ?in|sign ?up|register|forgot|click here|read more|learn more|view all|see all|website|home ?page|facebook|twitter|linkedin|instagram|youtube|support)\b/i;

export function senderAddress(from: string): string {
  return (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
}

export function senderName(from: string): string {
  const name = from.replace(/<[^>]*>/g, "").replace(/["']/g, "").trim();
  return name || senderAddress(from).split("@")[1] || "Tender alert";
}

/** Approved senders: the built-in tender platforms plus ALERT_EMAIL_SENDERS. */
export function readAllowedSenders(configured = process.env.ALERT_EMAIL_SENDERS ?? ""): string[] {
  const extra = configured.split(/[,;\s]+/).map((item) => item.trim().toLowerCase()).filter(Boolean);
  return [...new Set([...DEFAULT_ALERT_SENDER_DOMAINS, ...extra])];
}

export function isAllowedSender(from: string, allowed: readonly string[]): boolean {
  const address = senderAddress(from);
  const domain = address.split("@")[1] ?? "";
  if (!domain) return false;
  return allowed.some((entry) =>
    entry.includes("@")
      ? entry === address
      : domain === entry || domain.endsWith(`.${entry}`));
}

function cleanText(html: string, maxLen: number): string {
  return decodeEntities(stripHtml(decodeEntities(html), maxLen)).replace(/\s+/g, " ").trim();
}

function cleanSubject(subject: string): string {
  return subject.replace(/^(?:\s*(?:fwd?|re|fw)\s*:\s*)+/i, "").replace(/\s+/g, " ").trim();
}

function safeHttpUrl(href: string): string | undefined {
  try {
    const url = new URL(decodeEntities(href.trim()));
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Turn one alert email into leads. Each link whose text reads like a tender
 * title becomes a lead, with the text around it as its description. An email
 * with no such links becomes a single lead from its subject and body.
 */
export function parseAlertEmail(email: AlertEmail): AlertLead[] {
  const leads: AlertLead[] = [];
  const seen = new Set<string>();
  const html = email.html ?? "";
  if (html) {
    const body = html.replace(/<(?:script|style|head)\b[\s\S]*?<\/(?:script|style|head)>/gi, " ");
    const anchors = [...body.matchAll(/<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)]
      .map((match) => ({
        start: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
        url: safeHttpUrl(match[2]),
        title: cleanText(match[3], 300),
      }))
      .filter((anchor) =>
        anchor.url && anchor.title.length >= 15 && !BOILERPLATE_LINK.test(anchor.title) &&
        !/^https?:\/\//i.test(anchor.title));
    anchors.forEach((anchor, index) => {
      if (leads.length >= MAX_LEADS_PER_EMAIL || !anchor.url || seen.has(anchor.url)) return;
      seen.add(anchor.url);
      // The description is the text from this tender's link up to the next
      // tender's link (alerts list each title first, then its details).
      const to = Math.min(index + 1 < anchors.length ? anchors[index + 1].start : body.length, anchor.end + 1_500);
      const context = cleanText(body.slice(anchor.start, to), 2_000);
      leads.push({ title: anchor.title, url: anchor.url, context, deadline: readListingDeadline(context) });
    });
  } else if (email.text) {
    // Plain-text alerts: a title line followed by its link.
    const lines = email.text.split(/\r?\n/).map((line) => line.trim());
    lines.forEach((line, index) => {
      const url = safeHttpUrl(line.match(/https?:\/\/\S+/)?.[0]?.replace(/[)>.,]+$/, "") ?? "");
      if (!url || seen.has(url) || leads.length >= MAX_LEADS_PER_EMAIL) return;
      const inline = line.replace(/https?:\/\/\S+/g, "").replace(/[:\-–|]+\s*$/, "").trim();
      const previous = [...lines.slice(Math.max(0, index - 3), index)].reverse().find((item) => item.length > 0) ?? "";
      const title = inline.length >= 15 ? inline : previous;
      if (title.length < 15 || BOILERPLATE_LINK.test(title)) return;
      seen.add(url);
      const context = lines.slice(Math.max(0, index - 3), index + 4).join(" ").replace(/\s+/g, " ").trim();
      leads.push({ title: title.slice(0, 300), url, context, deadline: readListingDeadline(context) });
    });
  }
  if (leads.length > 0) return leads;

  const subject = cleanSubject(email.subject);
  const bodyText = html ? cleanText(html, 4_000) : (email.text ?? "").replace(/\s+/g, " ").trim().slice(0, 4_000);
  if (subject.length < 8 || bodyText.length < 40) return [];
  const firstLink = html
    ? safeHttpUrl(html.match(/<a\b[^>]*href=(["'])(https?:\/\/.*?)\1/i)?.[2] ?? "")
    : safeHttpUrl(bodyText.match(/https?:\/\/\S+/)?.[0] ?? "");
  return [{ title: subject, url: firstLink, context: bodyText, deadline: readListingDeadline(bodyText) }];
}

export type AlertMailboxReader = () => Promise<AlertEmail[]>;

/** Read recent mail from the Resend receiving mailbox. */
export function resendMailboxReader(apiKey: string): AlertMailboxReader {
  return async () => {
    const resend = new Resend(apiKey);
    const listed = await resend.emails.receiving.list({ limit: 100 });
    if (listed.error) {
      throw new Error(`Could not read the alert mailbox: ${listed.error.message}`);
    }
    const allowed = readAllowedSenders();
    const cutoff = Date.now() - LOOKBACK_DAYS * DAY_MS;
    const emails: AlertEmail[] = [];
    for (const item of listed.data.data) {
      if (emails.length >= MAX_EMAILS_PER_RUN) break;
      const receivedAt = new Date(item.created_at);
      if (!Number.isNaN(receivedAt.getTime()) && receivedAt.getTime() < cutoff) continue;
      // Skip unapproved senders before downloading the message body.
      if (!isAllowedSender(item.from, allowed)) continue;
      const full = await resend.emails.receiving.get(item.id, { html_format: "cid" });
      if (full.error || !full.data) continue;
      emails.push({
        id: item.id,
        from: item.from,
        subject: item.subject ?? "",
        receivedAt: Number.isNaN(receivedAt.getTime()) ? undefined : receivedAt,
        html: full.data.html,
        text: full.data.text,
      });
    }
    return emails;
  };
}

export class EmailAlertAdapter implements TenderSourceAdapter {
  adapterType = "email_alerts";

  constructor(private readonly readMailbox?: AlertMailboxReader) {}

  async fetchOpportunities(context?: AdapterFetchContext): Promise<TenderOpportunity[]> {
    let reader = this.readMailbox;
    if (!reader) {
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey) {
        throw new Error("Email alerts need the RESEND_API_KEY secret and receiving switched on in Resend.");
      }
      reader = resendMailboxReader(apiKey);
    }
    const allowed = readAllowedSenders();
    const now = new Date();
    const results: TenderOpportunity[] = [];
    const seen = new Set<string>();
    let read = 0;
    let rejectedSenders = 0;
    let expired = 0;

    for (const email of await reader()) {
      if (results.length >= MAX_LEADS_PER_RUN) break;
      // Checked again here so a custom reader cannot skip the sender rule.
      if (!isAllowedSender(email.from, allowed)) {
        rejectedSenders++;
        continue;
      }
      read++;
      const organization = `${senderName(email.from)} (email alert)`;
      for (const lead of parseAlertEmail(email)) {
        if (results.length >= MAX_LEADS_PER_RUN) break;
        if (lead.deadline && lead.deadline.getTime() + DAY_MS < now.getTime()) {
          expired++;
          continue;
        }
        const externalId = stableExternalId("alert", lead.url ?? `${email.id}:${lead.title}`);
        if (seen.has(externalId)) continue;
        seen.add(externalId);
        const hasScope = lead.context.replace(lead.title, "").trim().length >= 120;
        results.push({
          externalId,
          title: lead.title,
          organization,
          url: lead.url,
          deadline: lead.deadline,
          description: hasScope ? lead.context.slice(0, 4_000) : `${lead.title}. ${lead.context}`.slice(0, 4_000),
          sector: "Tender alert email",
          rawData: {
            sourcePage: "email-alert",
            alertEmailId: email.id,
            alertFrom: senderAddress(email.from),
            alertSubject: cleanSubject(email.subject).slice(0, 300),
            extractionMethod: "alert_email",
            descriptionStatus: hasScope ? "substantive" : "insufficient_scope",
            ...(email.receivedAt ? { postedAt: email.receivedAt.toISOString() } : {}),
            ...(hasScope ? {} : { needsEnrichment: true }),
          },
        });
      }
    }

    context?.diagnostics?.push({
      code: "direct_success",
      url: "https://resend.com/emails/receiving",
      message: `Read ${read} alert emails and found ${results.length} leads` +
        `${expired ? `; skipped ${expired} expired` : ""}` +
        `${rejectedSenders ? `; ignored ${rejectedSenders} from unapproved senders` : ""}.`,
      method: "direct",
    });
    return results;
  }
}
