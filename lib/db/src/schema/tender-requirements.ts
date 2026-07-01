import { pgTable, text, serial, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

import { tendersTable } from "./tenders";

export const tenderRequirementsTable = pgTable("tender_requirements", {
  id: serial("id").primaryKey(),
  tenderId: integer("tender_id").notNull().references(() => tendersTable.id, { onDelete: "cascade" }),
  requirementText: text("requirement_text").notNull(),
  category: text("category").notNull().default("general"),
  isMandatory: boolean("is_mandatory").notNull().default(true),
  isAnswered: boolean("is_answered").notNull().default(false),
  answeredInSectionId: integer("answered_in_section_id"),
  orderIndex: integer("order_index").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertTenderRequirementSchema = createInsertSchema(tenderRequirementsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertTenderRequirement = z.infer<typeof insertTenderRequirementSchema>;
export type TenderRequirement = typeof tenderRequirementsTable.$inferSelect;
