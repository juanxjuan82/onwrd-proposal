import { pgTable, text, serial, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const knowledgeDocumentsTable = pgTable("knowledge_documents", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  docType: text("doc_type").notNull().default("capability"),
  isApproved: boolean("is_approved").notNull().default(false),
  sourceUrl: text("source_url"),
  tags: text("tags").notNull().default("[]"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertKnowledgeDocumentSchema = createInsertSchema(knowledgeDocumentsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertKnowledgeDocument = z.infer<typeof insertKnowledgeDocumentSchema>;
export type KnowledgeDocument = typeof knowledgeDocumentsTable.$inferSelect;
