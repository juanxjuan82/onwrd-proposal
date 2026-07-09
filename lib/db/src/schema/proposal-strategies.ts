import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { tendersTable } from "./tenders";

export const proposalStrategiesTable = pgTable("proposal_strategies", {
  id: serial("id").primaryKey(),
  tenderId: integer("tender_id").notNull().references(() => tendersTable.id, { onDelete: "cascade" }),
  positioning: text("positioning").notNull().default(""),
  winThemes: text("win_themes").notNull().default("[]"),
  recommendedCaseStudies: text("recommended_case_studies").notNull().default("[]"),
  risks: text("risks").notNull().default("[]"),
  messagingGuidance: text("messaging_guidance").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type ProposalStrategy = typeof proposalStrategiesTable.$inferSelect;
