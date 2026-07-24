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
  sourceType: text("source_type"),
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
  // ── Analysis telemetry ────────────────────────────────────────────────────
  analysisRunId: text("analysis_run_id"),
  analysisStartedAt: timestamp("analysis_started_at"),
  analysisCompletedAt: timestamp("analysis_completed_at"),
  cancelledAt: timestamp("cancelled_at"),
  failedStep: text("failed_step"),
  failedErrorCode: text("failed_error_code"),
  completedSteps: text("completed_steps"),
  aiInputTokens: integer("ai_input_tokens"),
  aiOutputTokens: integer("ai_output_tokens"),
  aiModelUsed: text("ai_model_used"),
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
