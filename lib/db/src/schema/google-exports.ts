import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

import { proposalsTable } from "./proposals";

export const googleExportsTable = pgTable("google_exports", {
  id: serial("id").primaryKey(),
  proposalId: integer("proposal_id").notNull().references(() => proposalsTable.id, { onDelete: "cascade" }),
  googleDocUrl: text("google_doc_url").notNull(),
  googleFileId: text("google_file_id").notNull(),
  driveFolderId: text("drive_folder_id"),
  exportedAt: timestamp("exported_at").notNull().defaultNow(),
  exportedBy: text("exported_by"),
});

export const insertGoogleExportSchema = createInsertSchema(googleExportsTable).omit({
  id: true,
  exportedAt: true,
});

export type InsertGoogleExport = z.infer<typeof insertGoogleExportSchema>;
export type GoogleExport = typeof googleExportsTable.$inferSelect;
