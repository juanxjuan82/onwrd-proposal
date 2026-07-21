import { Router } from "express";
import { db } from "@workspace/db";
import { googleDriveConfigTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

router.get("/settings/google-drive", async (_req, res) => {
  try {
    const [config] = await db.select().from(googleDriveConfigTable).limit(1);
    res.json(config ?? { folderId: null, driveId: null, folderName: null });
  } catch (err) {
    console.error("[drive-config] GET error:", err);
    res.status(500).json({ error: "Failed to load Drive configuration" });
  }
});

router.post("/settings/google-drive", async (req, res) => {
  const body = req.body as { folderId?: unknown; driveId?: unknown; folderName?: unknown };
  const folderId = typeof body.folderId === "string" ? body.folderId.trim() : "";
  const driveId = typeof body.driveId === "string" ? body.driveId.trim() : null;
  const folderName = typeof body.folderName === "string" ? body.folderName.trim() : null;

  if (!folderId) {
    res.status(400).json({ error: "folderId is required" });
    return;
  }

  try {
    const [existing] = await db.select().from(googleDriveConfigTable).limit(1);

    if (existing) {
      const [updated] = await db
        .update(googleDriveConfigTable)
        .set({ folderId, driveId: driveId || null, folderName: folderName || null, updatedAt: new Date() })
        .where(eq(googleDriveConfigTable.id, existing.id))
        .returning();
      res.json(updated);
    } else {
      const [inserted] = await db
        .insert(googleDriveConfigTable)
        .values({ folderId, driveId: driveId || null, folderName: folderName || null })
        .returning();
      res.json(inserted);
    }
  } catch (err) {
    console.error("[drive-config] POST error:", err);
    res.status(500).json({ error: "Failed to save Drive configuration" });
  }
});

router.delete("/settings/google-drive", async (_req, res) => {
  try {
    const [existing] = await db.select().from(googleDriveConfigTable).limit(1);
    if (existing) {
      await db.delete(googleDriveConfigTable).where(eq(googleDriveConfigTable.id, existing.id));
    }
    res.json({ success: true });
  } catch (err) {
    console.error("[drive-config] DELETE error:", err);
    res.status(500).json({ error: "Failed to clear Drive configuration" });
  }
});

export default router;
