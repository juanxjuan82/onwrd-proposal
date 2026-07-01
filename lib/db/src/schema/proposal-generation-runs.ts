import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

import { proposalsTable } from "./proposals";

export const proposalGenerationRunsTable = pgTable("proposal_generation_runs", {
  id: serial("id").primaryKey(),
  proposalId: integer("proposal_id").notNull().references(() => proposalsTable.id, { onDelete: "cascade" }),
  model: text("model").notNull().default("gpt-5.2"),
  promptVersion: text("prompt_version").notNull().default("1.0"),
  retrievedKnowledgeIds: text("retrieved_knowledge_ids").notNull().default("[]"),
  critiqueFindings: text("critique_findings"),
  status: text("status").notNull().default("completed"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertProposalGenerationRunSchema = createInsertSchema(proposalGenerationRunsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertProposalGenerationRun = z.infer<typeof insertProposalGenerationRunSchema>;
export type ProposalGenerationRun = typeof proposalGenerationRunsTable.$inferSelect;
