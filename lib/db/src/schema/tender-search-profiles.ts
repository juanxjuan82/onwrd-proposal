import { pgTable, text, serial, timestamp, boolean } from "drizzle-orm/pg-core";

export const tenderSearchProfilesTable = pgTable("tender_search_profiles", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  keywords: text("keywords").notNull().default("[]"),
  excludedKeywords: text("excluded_keywords").notNull().default("[]"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type TenderSearchProfile = typeof tenderSearchProfilesTable.$inferSelect;
