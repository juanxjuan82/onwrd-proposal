import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";

export const aiUsageLogTable = pgTable("ai_usage_log", {
  id:           serial("id").primaryKey(),
  requestId:    text("request_id").notNull(),
  feature:      text("feature").notNull(),
  opportunityId: integer("opportunity_id"),
  proposalId:   integer("proposal_id"),
  operationKey: text("operation_key"),
  model:        text("model"),
  status:       text("status").notNull().default("pending"),
  startedAt:    timestamp("started_at").notNull().defaultNow(),
  completedAt:  timestamp("completed_at"),
  inputTokens:  integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  errorCode:    text("error_code"),
});

export type AiUsageLog = typeof aiUsageLogTable.$inferSelect;
