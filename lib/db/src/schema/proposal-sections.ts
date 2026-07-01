import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

import { proposalsTable } from "./proposals";

export const proposalSectionsTable = pgTable("proposal_sections", {
  id: serial("id").primaryKey(),
  proposalId: integer("proposal_id").notNull().references(() => proposalsTable.id, { onDelete: "cascade" }),
  sectionKey: text("section_key").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull().default(""),
  status: text("status").notNull().default("not_started"),
  criticFindings: text("critic_findings"),
  generationRunId: integer("generation_run_id"),
  orderIndex: integer("order_index").notNull().default(0),
  reviewedAt: timestamp("reviewed_at"),
  approvedAt: timestamp("approved_at"),
  approvedBy: text("approved_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertProposalSectionSchema = createInsertSchema(proposalSectionsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertProposalSection = z.infer<typeof insertProposalSectionSchema>;
export type ProposalSection = typeof proposalSectionsTable.$inferSelect;
