import { pgTable, text, serial, timestamp, integer, jsonb } from "drizzle-orm/pg-core";

export const discoveredTendersTable = pgTable("discovered_tenders", {
  id: serial("id").primaryKey(),
  sourceId: integer("source_id").notNull(),
  externalId: text("external_id"),
  title: text("title").notNull(),
  organization: text("organization").notNull(),
  url: text("url"),
  deadline: timestamp("deadline"),
  description: text("description").notNull().default(""),
  country: text("country"),
  sector: text("sector"),
  valueAmount: text("value_amount"),
  rawData: jsonb("raw_data"),
  status: text("status").notNull().default("new"),
  fitScore: integer("fit_score"),
  recommendation: text("recommendation"),
  scoringReasoning: text("scoring_reasoning"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type DiscoveredTender = typeof discoveredTendersTable.$inferSelect;
