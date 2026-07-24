import { pgTable, text, serial, timestamp, integer, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const proposalsTable = pgTable("proposals", {
  id: serial("id").primaryKey(),
  clientName: text("client_name").notNull(),
  industry: text("industry").notNull(),
  status: text("status").notNull().default("draft"),
  briefText: text("brief_text").notNull(),
  proposalContent: text("proposal_content").notNull(),
  googleDocUrl: text("google_doc_url"),
  googleFileId: text("google_file_id"),
  driveFolderId: text("drive_folder_id"),
  syncStatus: text("sync_status"),
  lastSyncedAt: timestamp("last_synced_at"),
  dirtySince: timestamp("dirty_since"),
  handoffStartedAt: timestamp("handoff_started_at"),
  tenderId: integer("tender_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  unique("proposals_tender_id_unique").on(t.tenderId),
]);

export const insertProposalSchema = createInsertSchema(proposalsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertProposal = z.infer<typeof insertProposalSchema>;
export type Proposal = typeof proposalsTable.$inferSelect;
