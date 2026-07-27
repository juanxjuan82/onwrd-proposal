import { pgTable, text, serial, timestamp, integer, jsonb } from "drizzle-orm/pg-core";

import { tendersTable } from "./tenders";

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
  geographyScore: integer("geography_score"),
  geoRegion: text("geo_region"),
  bahamasAdvantageScore: integer("bahamas_advantage_score"),
  confidence: text("confidence"),
  rejectionReasons: jsonb("rejection_reasons"),           // string[] — populated when ineligible
  opportunityId: integer("opportunity_id").references(() => tendersTable.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type DiscoveredTender = typeof discoveredTendersTable.$inferSelect;
