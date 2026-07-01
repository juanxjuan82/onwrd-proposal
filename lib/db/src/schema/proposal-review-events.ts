import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

import { proposalsTable } from "./proposals";

export const proposalReviewEventsTable = pgTable("proposal_review_events", {
  id: serial("id").primaryKey(),
  proposalId: integer("proposal_id").notNull().references(() => proposalsTable.id, { onDelete: "cascade" }),
  sectionId: integer("section_id"),
  eventType: text("event_type").notNull(),
  notes: text("notes"),
  overrideReason: text("override_reason"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertProposalReviewEventSchema = createInsertSchema(proposalReviewEventsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertProposalReviewEvent = z.infer<typeof insertProposalReviewEventSchema>;
export type ProposalReviewEvent = typeof proposalReviewEventsTable.$inferSelect;
