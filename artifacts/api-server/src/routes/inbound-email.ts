import { Router, type Request } from "express";
import mammoth from "mammoth";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { Resend } from "resend";
import { db, inboundEmailsTable, tendersTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { applyDeterministicScore } from "../lib/apply-deterministic-score.js";
import {
  buildTenderFromEmail,
  isRecipientAccepted,
  isSenderAllowed,
  parseEmailAddress,
  readInboundEmailConfig,
  selectReadableAttachments,
  MAX_ATTACHMENT_BYTES,
  type InboundAttachmentText,
  type InboundEmailContent,
} from "../lib/inbound-email.js";
import { ALLOWED_EMAIL_DOMAIN } from "../lib/allowed-domain.js";

const router = Router();

/**
 * Everything the handler needs from the email provider. Kept behind a small
 * interface so tests can drive the route without calling Resend.
 */
export interface InboundEmailProvider {
  /** Throws when the signature is missing or wrong. Returns the parsed event. */
  verify(rawBody: string, headers: { id: string; timestamp: string; signature: string }): {
    type: string;
    data: { email_id?: string };
  };
  getEmail(emailId: string): Promise<InboundEmailContent>;
  listAttachments(emailId: string): Promise<Array<{
    filename?: string | null; size: number; content_type?: string; download_url: string;
  }>>;
}

function createResendProvider(apiKey: string, webhookSecret: string): InboundEmailProvider {
  const resend = new Resend(apiKey);
  return {
    verify(rawBody, headers) {
      return resend.webhooks.verify({ payload: rawBody, headers, webhookSecret }) as {
        type: string; data: { email_id?: string };
      };
    },
    async getEmail(emailId) {
      const { data, error } = await resend.emails.receiving.get(emailId);
      if (error || !data) throw new Error(`Could not fetch received email: ${error?.message ?? "no data"}`);
      return {
        id: data.id,
        from: data.from,
        to: data.to ?? [],
        receivedFor: data.received_for ?? [],
        subject: data.subject ?? "",
        text: data.text,
        html: data.html,
        messageId: data.message_id,
      };
    },
    async listAttachments(emailId) {
      const { data, error } = await resend.emails.receiving.attachments.list({ emailId });
      if (error || !data) throw new Error(`Could not list attachments: ${error?.message ?? "no data"}`);
      return data.data;
    },
  };
}

let providerOverride: InboundEmailProvider | null = null;
/** Test-only seam (null in production), mirroring the other __set…ForTesting hooks. */
export function __setInboundEmailProviderForTesting(provider: InboundEmailProvider | null): void {
  providerOverride = provider;
}

function getProvider(): InboundEmailProvider | null {
  if (providerOverride) return providerOverride;
  const apiKey = process.env.RESEND_API_KEY;
  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET;
  // Fail closed: without BOTH secrets the endpoint accepts nothing.
  if (!apiKey || !webhookSecret) return null;
  return createResendProvider(apiKey, webhookSecret);
}

async function readAttachment(
  attachment: { filename?: string | null; content_type?: string; download_url: string },
): Promise<InboundAttachmentText | null> {
  const filename = attachment.filename ?? "attachment";
  // The download link is issued by the email provider for this message.
  if (!/^https:\/\//i.test(attachment.download_url)) return null;
  const response = await fetch(attachment.download_url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) return null;
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_ATTACHMENT_BYTES) return null;
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0 || buffer.length > MAX_ATTACHMENT_BYTES) return null;

  const name = filename.toLowerCase();
  const type = (attachment.content_type ?? "").toLowerCase();
  let text = "";
  if (buffer.subarray(0, 5).toString("latin1") === "%PDF-") {
    text = (await pdfParse(buffer)).text ?? "";
  } else if (name.endsWith(".docx") || type.includes("wordprocessingml")) {
    text = (await mammoth.extractRawText({ buffer })).value ?? "";
  } else if (name.endsWith(".txt") || type === "text/plain") {
    text = buffer.toString("utf-8");
  }
  text = text.replace(/[ \t]+/g, " ").trim().slice(0, 120_000);
  return text ? { filename: filename.slice(0, 200), text } : null;
}

// ── Webhook: the email provider calls this when a forwarded email arrives ────
// PUBLIC route (see apiGuard.ts) — it is authenticated by the provider's
// signature over the raw request body, not by a user session.
router.post("/inbound/email", async (req, res) => {
  const provider = getProvider();
  if (!provider) {
    res.status(503).json({ error: "Email forwarding is not configured." });
    return;
  }

  const rawBody = (req as Request & { rawBody?: string }).rawBody;
  const header = (name: string) => {
    const value = req.headers[name];
    return typeof value === "string" ? value : "";
  };
  let event: { type: string; data: { email_id?: string } };
  try {
    if (!rawBody) throw new Error("missing raw body");
    event = provider.verify(rawBody, {
      id: header("svix-id"),
      timestamp: header("svix-timestamp"),
      signature: header("svix-signature"),
    });
  } catch {
    res.status(401).json({ error: "Invalid webhook signature." });
    return;
  }

  const emailId = event.data?.email_id;
  if (event.type !== "email.received" || !emailId) {
    res.status(200).json({ ignored: true });
    return;
  }

  // Idempotency: the provider retries deliveries. Claim the email first; a
  // second delivery finds the row and stops (unless the first attempt failed).
  let [claim] = await db.insert(inboundEmailsTable)
    .values({ emailId, status: "processing" })
    .onConflictDoNothing({ target: inboundEmailsTable.emailId })
    .returning({ id: inboundEmailsTable.id });
  if (!claim) {
    [claim] = await db.update(inboundEmailsTable)
      .set({ status: "processing", reason: null, updatedAt: new Date() })
      .where(and(eq(inboundEmailsTable.emailId, emailId), eq(inboundEmailsTable.status, "failed")))
      .returning({ id: inboundEmailsTable.id });
    if (!claim) {
      res.status(200).json({ duplicate: true });
      return;
    }
  }
  const finish = (values: Partial<typeof inboundEmailsTable.$inferInsert>) =>
    db.update(inboundEmailsTable).set({ ...values, updatedAt: new Date() })
      .where(eq(inboundEmailsTable.id, claim.id));

  try {
    const config = readInboundEmailConfig();
    const email = await provider.getEmail(emailId);
    const summary = {
      messageId: email.messageId ?? null,
      fromAddress: (parseEmailAddress(email.from) ?? email.from ?? "").slice(0, 320),
      subject: (email.subject ?? "").slice(0, 300),
    };

    if (!isRecipientAccepted(email, config)) {
      await finish({ ...summary, status: "rejected_recipient", reason: "Not addressed to the forwarding address." });
      res.status(200).json({ accepted: false });
      return;
    }
    if (!isSenderAllowed(email.from, config)) {
      await finish({ ...summary, status: "rejected_sender", reason: "Sender is not on the approved list." });
      req.log.warn({ emailId }, "[inbound-email] rejected: sender not approved");
      res.status(200).json({ accepted: false });
      return;
    }

    const attachments: InboundAttachmentText[] = [];
    let attachmentCount = 0;
    try {
      const listed = await provider.listAttachments(emailId);
      attachmentCount = listed.length;
      for (const attachment of selectReadableAttachments(listed)) {
        try {
          const read = await readAttachment(attachment);
          if (read) attachments.push(read);
        } catch (err) {
          req.log.warn({ err, emailId }, "[inbound-email] attachment could not be read");
        }
      }
    } catch (err) {
      // The body alone is still worth importing.
      req.log.warn({ err, emailId }, "[inbound-email] attachments unavailable");
    }

    const built = buildTenderFromEmail(email, attachments);
    if (!built.ok) {
      await finish({ ...summary, attachmentCount, status: "empty", reason: built.reason });
      res.status(200).json({ accepted: false });
      return;
    }

    const [created] = await db.insert(tendersTable).values({
      ...built.draft,
      sourceType: "email",
      status: "opportunity_found",
      recommendationScore: 0,
    }).returning({ id: tendersTable.id });

    // Deterministic scoring only — no AI call. Same outcome as a manual import.
    let status = "pending_review";
    try {
      const score = await applyDeterministicScore(db, created.id);
      status = score.fitLevel === "no_bid" ? "no_bid" : "pending_review";
    } catch (err) {
      req.log.warn({ err }, "[inbound-email] auto-score failed");
    }
    await db.update(tendersTable).set({ status, updatedAt: new Date() })
      .where(eq(tendersTable.id, created.id));

    await finish({ ...summary, attachmentCount, status: "imported", tenderId: created.id, reason: null });
    req.log.info({ emailId, tenderId: created.id }, "[inbound-email] imported");
    res.status(200).json({ accepted: true, opportunityId: created.id });
  } catch (err) {
    req.log.error({ err, emailId }, "[inbound-email] processing failed");
    await finish({ status: "failed", reason: (err instanceof Error ? err.message : String(err)).slice(0, 300) })
      .catch(() => undefined);
    // Non-2xx asks the provider to retry later.
    res.status(500).json({ error: "Processing failed." });
  }
});

// ── Status for the settings page (requires a signed-in user) ─────────────────
router.get("/inbound/email/status", async (_req, res) => {
  const config = readInboundEmailConfig();
  const recent = await db.select({
    id: inboundEmailsTable.id,
    fromAddress: inboundEmailsTable.fromAddress,
    subject: inboundEmailsTable.subject,
    status: inboundEmailsTable.status,
    reason: inboundEmailsTable.reason,
    tenderId: inboundEmailsTable.tenderId,
    receivedAt: inboundEmailsTable.receivedAt,
  }).from(inboundEmailsTable).orderBy(desc(inboundEmailsTable.receivedAt)).limit(10);

  res.json({
    configured: Boolean(process.env.RESEND_API_KEY && process.env.RESEND_WEBHOOK_SECRET),
    forwardingAddress: config.forwardingAddress,
    companyDomain: ALLOWED_EMAIL_DOMAIN,
    allowedSenders: config.allowedSenders,
    recent,
  });
});

export default router;
