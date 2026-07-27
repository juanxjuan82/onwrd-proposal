import { pgTable, text, serial, timestamp, integer, boolean, jsonb } from "drizzle-orm/pg-core";

export const crawlerRunsTable = pgTable("crawler_runs", {
  id: serial("id").primaryKey(),
  batchId: text("batch_id"),                              // links to crawl_batches.id
  sourceId: integer("source_id").notNull(),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
  status: text("status").notNull().default("running"),    // running|success|partial|failed
  // adapter-level request counts (from AdapterFetchResult)
  requestsAttempted: integer("requests_attempted").notNull().default(0),
  requestsSucceeded: integer("requests_succeeded").notNull().default(0),
  warnings: jsonb("warnings"),                            // string[]
  // discovery-level counts
  itemsFound: integer("items_found").notNull().default(0),
  itemsNew: integer("items_new").notNull().default(0),    // inserted
  itemsUpdated: integer("items_updated").notNull().default(0),
  itemsEligible: integer("items_eligible").notNull().default(0),
  itemsPromoted: integer("items_promoted").notNull().default(0),
  itemsRejected: integer("items_rejected").notNull().default(0),
  itemsUnchanged: integer("items_unchanged").notNull().default(0),
  rejectionCounts: jsonb("rejection_counts"),             // { reason: count }
  errorMessage: text("error_message"),
  aiProvider: text("ai_provider"),
  aiModel: text("ai_model"),
  aiCallCount: integer("ai_call_count").notNull().default(0),
  aiFallbackCount: integer("ai_fallback_count").notNull().default(0),
  aiQuotaError: boolean("ai_quota_error").notNull().default(false),
});

export type CrawlerRun = typeof crawlerRunsTable.$inferSelect;
