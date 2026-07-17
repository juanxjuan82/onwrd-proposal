import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

import { tendersTable } from "./tenders";

export const bidScoresTable = pgTable("bid_scores", {
  id: serial("id").primaryKey(),
  tenderId: integer("tender_id").notNull().references(() => tendersTable.id, { onDelete: "cascade" }),
  fitScore: integer("fit_score").notNull().default(0),
  fitLevel: text("fit_level").notNull().default("weak"),
  reasoning: text("reasoning").notNull().default(""),
  flags: text("flags").notNull().default("[]"),
  completenessScore: integer("completeness_score").notNull().default(0),
  missingFields: text("missing_fields").notNull().default("[]"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertBidScoreSchema = createInsertSchema(bidScoresTable).omit({
  id: true,
  createdAt: true,
});

export type InsertBidScore = z.infer<typeof insertBidScoreSchema>;
export type BidScore = typeof bidScoresTable.$inferSelect;
