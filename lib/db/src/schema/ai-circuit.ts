import { pgTable, integer, boolean, timestamp, text } from "drizzle-orm/pg-core";

export const aiCircuitTable = pgTable("ai_circuit", {
  id:        integer("id").primaryKey().default(1),
  open:      boolean("open").notNull().default(false),
  openedAt:  timestamp("opened_at"),
  errorCode: text("error_code"),
  resetAt:   timestamp("reset_at"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type AiCircuit = typeof aiCircuitTable.$inferSelect;
