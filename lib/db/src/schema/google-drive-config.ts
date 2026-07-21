import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";

export const googleDriveConfigTable = pgTable("google_drive_config", {
  id: serial("id").primaryKey(),
  folderId: text("folder_id").notNull(),
  driveId: text("drive_id"),
  folderName: text("folder_name"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type GoogleDriveConfig = typeof googleDriveConfigTable.$inferSelect;
