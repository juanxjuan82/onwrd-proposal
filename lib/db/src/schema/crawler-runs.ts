import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";

export const crawlerRunsTable = pgTable("crawler_runs", {
  id: serial("id").primaryKey(),
  sourceId: integer("source_id").notNull(),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
  status: text("status").notNull().default("running"),
  itemsFound: integer("items_found").notNull().default(0),
  itemsNew: integer("items_new").notNull().default(0),
  errorMessage: text("error_message"),
});

export type CrawlerRun = typeof crawlerRunsTable.$inferSelect;
