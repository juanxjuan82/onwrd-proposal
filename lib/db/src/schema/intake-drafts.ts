import { pgTable, text, serial, timestamp, integer, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

import { tendersTable } from "./tenders";

export const intakeDraftsTable = pgTable("intake_drafts", {
  id: serial("id").primaryKey(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  jobTitle: text("job_title").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  preferredContact: text("preferred_contact"),
  status: text("status").notNull().default("draft"),
  submissionKey: text("submission_key"),
  proposalId: integer("proposal_id"),
  opportunityId: integer("opportunity_id").references(() => tendersTable.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  unique("intake_drafts_submission_key_unique").on(t.submissionKey),
]);

export const insertIntakeDraftSchema = createInsertSchema(intakeDraftsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertIntakeDraft = z.infer<typeof insertIntakeDraftSchema>;
export type IntakeDraft = typeof intakeDraftsTable.$inferSelect;
