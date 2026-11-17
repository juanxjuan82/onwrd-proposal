import { pgTable, text, serial, timestamp, integer, boolean, jsonb } from "drizzle-orm/pg-core";

export const crawlerRunsTable = pgTable("crawler_runs", {
  id: serial("id").primaryKey(),
  sourceId: integer("source_id").notNull(),
  sourceConfigurationVersion: integer("source_configuration_version").notNull().default(0),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
  status: text("status").notNull().default("running"),
  itemsFound: integer("items_found").notNull().default(0),
  itemsNew: integer("items_new").notNull().default(0),
  errorMessage: text("error_message"),
  aiProvider: text("ai_provider"),
  aiModel: text("ai_model"),
  aiCallCount: integer("ai_call_count").notNull().default(0),
  aiFallbackCount: integer("ai_fallback_count").notNull().default(0),
  aiQuotaError: boolean("ai_quota_error").notNull().default(false),
  crawlMethod: text("crawl_method").notNull().default("direct"),
  crawl4aiAttempts: integer("crawl4ai_attempts").notNull().default(0),
  crawl4aiSuccesses: integer("crawl4ai_successes").notNull().default(0),
  crawlDiagnostics: jsonb("crawl_diagnostics"),
});

export type CrawlerRun = typeof crawlerRunsTable.$inferSelect;
