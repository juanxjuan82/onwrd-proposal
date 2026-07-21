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
  let folderName = typeof body.folderName === "string" ? body.folderName.trim() : null;

  if (!folderId) {
    res.status(400).json({ error: "folderId is required" });
    return;
  }

  // ── Validate folder access via Google Drive API (when user is connected) ──
  const accessToken: string | undefined = req.session.googleAccessToken;
  if (accessToken) {
    try {
      const params = new URLSearchParams({
        fields: "id,name,mimeType",
        supportsAllDrives: "true",
      });
      if (driveId) {
        params.set("driveId", driveId);
        params.set("includeItemsFromAllDrives", "true");
      }

      const driveRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?${params.toString()}`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );

      if (!driveRes.ok) {
        const status = driveRes.status;
        const errMsg =
          status === 404
            ? "Folder not found. Double-check the folder ID from the Google Drive URL."
            : status === 403
            ? "You don't have permission to access this folder. Make sure you have at least Viewer access."
            : `Could not verify folder access (HTTP ${status}). Check the ID and try again.`;
        res.status(400).json({ error: errMsg });
        return;
      }

      const data = (await driveRes.json()) as { name?: string; mimeType?: string };
      if (data.mimeType && !data.mimeType.includes("folder")) {
        res.status(400).json({
          error:
            "The ID provided is not a folder. Use the folder ID from a Google Drive folder URL, not a file ID.",
        });
        return;
      }

      // Auto-populate folderName from the Drive API when not provided by user
      if (!folderName && data.name) folderName = data.name;
    } catch (err) {
      console.error("[drive-config] folder validation error:", err);
      res.status(500).json({ error: "Could not reach Google Drive to verify the folder. Try again." });
      return;
    }
  }

  // ── Save to DB ─────────────────────────────────────────────────────────────
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
