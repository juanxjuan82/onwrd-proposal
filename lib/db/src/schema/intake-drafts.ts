import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const intakeDraftsTable = pgTable("intake_drafts", {
  id: serial("id").primaryKey(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  jobTitle: text("job_title").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  preferredContact: text("preferred_contact"),
  status: text("status").notNull().default("draft"),
  proposalId: integer("proposal_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertIntakeDraftSchema = createInsertSchema(intakeDraftsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertIntakeDraft = z.infer<typeof insertIntakeDraftSchema>;
export type IntakeDraft = typeof intakeDraftsTable.$inferSelect;
