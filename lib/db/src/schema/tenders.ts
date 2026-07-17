import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

import { proposalsTable } from "./proposals";

export const tendersTable = pgTable("tenders", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  agency: text("agency").notNull(),
  description: text("description").notNull(),
  category: text("category").notNull().default("General"),
  deadline: timestamp("deadline", { withTimezone: true }),
  valueAmount: text("value_amount"),
  sourceUrl: text("source_url"),
  contactInfo: text("contact_info"),
  rawText: text("raw_text"),
  status: text("status").notNull().default("opportunity_found"),
  recommendationScore: integer("recommendation_score").notNull().default(0),
  requirementsExtractedAt: timestamp("requirements_extracted_at"),
  proposalId: integer("proposal_id").references(() => proposalsTable.id, {
    onDelete: "set null",
  }),
  googleDocId: text("google_doc_id"),
  googleDocUrl: text("google_doc_url"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertTenderSchema = createInsertSchema(tendersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  recommendationScore: true,
});

export type InsertTender = z.infer<typeof insertTenderSchema>;
export type Tender = typeof tendersTable.$inferSelect;
