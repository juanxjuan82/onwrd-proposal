import { pgTable, text, serial, timestamp, boolean, integer } from "drizzle-orm/pg-core";

export const tenderSourcesTable = pgTable("tender_sources", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  sourceType: text("source_type").notNull(),
  url: text("url").notNull(),
  adapterType: text("adapter_type").notNull(),
  active: boolean("active").notNull().default(true),
  lastCheckedAt: timestamp("last_checked_at"),
  lastSuccessAt: timestamp("last_success_at"),
  itemsFoundCount: integer("items_found_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type TenderSource = typeof tenderSourcesTable.$inferSelect;
