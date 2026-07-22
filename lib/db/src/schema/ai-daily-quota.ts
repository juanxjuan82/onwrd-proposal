import { pgTable, text, integer, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const aiDailyQuotaTable = pgTable(
  "ai_daily_quota",
  {
    date:      text("date").notNull(),
    scope:     text("scope").notNull(),
    calls:     integer("calls").notNull().default(0),
    tokens:    integer("tokens").notNull().default(0),
    updatedAt: timestamp("updated_at").notNull().default(sql`NOW()`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.date, t.scope] }),
  }),
);

export type AiDailyQuota = typeof aiDailyQuotaTable.$inferSelect;
