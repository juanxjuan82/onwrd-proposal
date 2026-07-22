import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const crawlerLockTable = pgTable("crawler_lock", {
  lockKey:    text("lock_key").primaryKey(),
  acquiredAt: timestamp("acquired_at").notNull().defaultNow(),
  expiresAt:  timestamp("expires_at").notNull(),
  instanceId: text("instance_id").notNull(),
});

export type CrawlerLock = typeof crawlerLockTable.$inferSelect;
