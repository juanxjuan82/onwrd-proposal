import { pgTable, text, serial, timestamp, boolean } from "drizzle-orm/pg-core";

export const tenderDigestSettingsTable = pgTable("tender_digest_settings", {
  id: serial("id").primaryKey(),
  emails: text("emails").notNull().default("[]"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type TenderDigestSettings = typeof tenderDigestSettingsTable.$inferSelect;
