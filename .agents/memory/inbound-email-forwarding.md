---
name: Email forwarding intake
description: How forwarded tender-alert emails become opportunities; security rules for the public webhook
---

Forwarded emails → `POST /api/inbound/email` (Resend Inbound webhook) → one `tenders` row (`sourceType: "email"`), scored deterministically like a manual import. Logic in `lib/inbound-email.ts`, route in `routes/inbound-email.ts`, log/idempotency table `inbound_emails` (created by the startup migration in `app.ts`).

**Rules**
- The webhook is on the PUBLIC allowlist; its only authentication is the provider signature over the RAW body (`express.json` `verify` hook stores `req.rawBody` for that path only). Never parse-then-restringify before verifying.
- Fails closed: without both `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` it returns 503 and does nothing.
- The webhook payload is metadata only; body and attachments are fetched from Resend by `email_id`.
- Senders must be on the company domain or in `INBOUND_EMAIL_ALLOWED_SENDERS` (comma-separated addresses/domains). Optional `INBOUND_EMAIL_ADDRESS` pins the recipient.
- No AI on this path, and links inside emails are never fetched — a forwarded email is not permission to crawl a robots-disallowed site.
- Email content is untrusted: `computeInjectionWarning` runs over every derived field.
- Deliveries are at-least-once: the `inbound_emails.email_id` unique row is claimed first; only a `failed` row may be re-claimed.

**Why:** the sites with the most relevant tenders (UNDP, Bahamas e-procurement, UNGM, OECS) forbid or block crawlers but do send email alerts to registered suppliers.
