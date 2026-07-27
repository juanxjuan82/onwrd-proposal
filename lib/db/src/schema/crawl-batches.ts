import { pgTable, text, timestamp, integer, jsonb } from "drizzle-orm/pg-core";

/**
 * One row per manual or scheduled crawl invocation.
 * Each batch covers all active sources; individual source results live in crawler_runs.
 * status: "running" | "success" | "partial" | "failed"
 */
export const crawlBatchesTable = pgTable("crawl_batches", {
  id: text("id").primaryKey(),           // UUID assigned at crawl start
  startedAt: timestamp("started_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
  status: text("status").notNull().default("running"),
  sourcesAttempted: integer("sources_attempted").notNull().default(0),
  sourcesSucceeded: integer("sources_succeeded").notNull().default(0),
  sourcesFailed: integer("sources_failed").notNull().default(0),
  fetched: integer("fetched").notNull().default(0),      // total items returned by adapters
  inserted: integer("inserted").notNull().default(0),    // net-new discoveries
  updated: integer("updated").notNull().default(0),      // enriched existing discoveries
  eligible: integer("eligible").notNull().default(0),    // passed eligibility gate
  promoted: integer("promoted").notNull().default(0),    // inserted into tenders
  rejected: integer("rejected").notNull().default(0),    // failed eligibility
  unchanged: integer("unchanged").notNull().default(0),  // duplicate, no change
  perSourceErrors: jsonb("per_source_errors"),           // { sourceId: errorMessage }
  rejectionCounts: jsonb("rejection_counts"),            // { reason: count }
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type CrawlBatch = typeof crawlBatchesTable.$inferSelect;
