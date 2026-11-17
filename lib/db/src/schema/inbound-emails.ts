import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";

import { tendersTable } from "./tenders";

// One row per email delivered to the app's forwarding address. Doubles as the
// idempotency key store (the email provider retries deliveries) and as an
// audit trail of what was accepted, rejected and why.
export const inboundEmailsTable = pgTable("inbound_emails", {
  id: serial("id").primaryKey(),
  /** Provider's ID for the received email — unique, used to ignore retries. */
  emailId: text("email_id").notNull().unique(),
  messageId: text("message_id"),
  fromAddress: text("from_address").notNull().default(""),
  subject: text("subject").notNull().default(""),
  /** processing | imported | rejected_sender | rejected_recipient | empty | failed */
  status: text("status").notNull().default("processing"),
  reason: text("reason"),
  tenderId: integer("tender_id").references(() => tendersTable.id, { onDelete: "set null" }),
  attachmentCount: integer("attachment_count").notNull().default(0),
  receivedAt: timestamp("received_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type InboundEmail = typeof inboundEmailsTable.$inferSelect;
