import { Router } from "express";
import { db } from "@workspace/db";
import { googleDriveConfigTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getValidGoogleAccessToken, GoogleAuthError } from "../lib/google-auth.js";

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

/**
 * Validate a folder ID against the Drive API.
 * Uses the correct fields-only request — never sends driveId or includeItemsFromAllDrives.
 */
async function validateFolder(
  folderId: string,
  accessToken: string,
): Promise<{
  ok: true;
  name: string;
  driveId: string | null;
} | {
  ok: false;
  code: "expired_auth" | "not_found" | "not_a_folder" | "no_write_permission" | "admin_restriction" | "temporary_failure";
  message: string;
}> {
  let driveRes: Response;
  try {
    driveRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}?supportsAllDrives=true&fields=id,name,mimeType,driveId,parents,capabilities(canAddChildren,canEdit)`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
  } catch {
    return { ok: false, code: "temporary_failure", message: "Could not reach Google Drive. Check your connection and try again." };
  }

  if (driveRes.status === 401) {
    return { ok: false, code: "expired_auth", message: "Google session expired. Reconnect your account and try again." };
  }
  if (driveRes.status === 403) {
    const body = await driveRes.json().catch(() => ({})) as { error?: { errors?: { domain?: string; reason?: string }[] } };
    const reason = body?.error?.errors?.[0]?.reason ?? "";
    if (reason === "domainPolicy" || reason === "teamDriveFileLimitExceeded") {
      return { ok: false, code: "admin_restriction", message: "An admin policy is preventing access to this folder." };
    }
    return { ok: false, code: "no_write_permission", message: "You don't have permission to create files in this folder. Ask the folder owner to grant you Editor access." };
  }
  if (driveRes.status === 404) {
    return { ok: false, code: "not_found", message: "Folder not found. Check that the ID is correct and you have access to it." };
  }
  if (driveRes.status >= 500) {
    return { ok: false, code: "temporary_failure", message: `Google Drive returned an error (HTTP ${driveRes.status}). Try again in a moment.` };
  }
  if (!driveRes.ok) {
    return { ok: false, code: "temporary_failure", message: `Unexpected error from Google Drive (HTTP ${driveRes.status}).` };
  }

  const data = (await driveRes.json()) as {
    name?: string;
    mimeType?: string;
    driveId?: string;
    capabilities?: { canAddChildren?: boolean; canEdit?: boolean };
  };

  if (data.mimeType !== "application/vnd.google-apps.folder") {
    return { ok: false, code: "not_a_folder", message: "The ID provided is not a folder. Use the folder ID from a Google Drive folder URL, not a file ID." };
  }

  if (data.capabilities?.canAddChildren !== true) {
    return { ok: false, code: "no_write_permission", message: "You can view this folder but cannot create files in it. Ask the owner to grant you Editor access." };
  }

  return {
    ok: true,
    name: data.name ?? folderId,
    driveId: data.driveId ?? null,
  };
}

router.post("/settings/google-drive", async (req, res) => {
  const body = req.body as { folderId?: unknown };
  const folderId = typeof body.folderId === "string" ? body.folderId.trim() : "";

  if (!folderId) {
    res.status(400).json({ error: "folderId is required" });
    return;
  }

  let accessToken: string;
  try {
    accessToken = await getValidGoogleAccessToken(req.session);
  } catch (err) {
    if (err instanceof GoogleAuthError) {
      res.status(401).json({ error: "Google account not connected. Connect your account first.", code: "expired_auth" });
      return;
    }
    res.status(500).json({ error: "Authentication error" });
    return;
  }

  const validation = await validateFolder(folderId, accessToken);
  if (!validation.ok) {
    res.status(validation.code === "expired_auth" ? 401 : 400).json({ error: validation.message, code: validation.code });
    return;
  }

  try {
    const [existing] = await db.select().from(googleDriveConfigTable).limit(1);
    if (existing) {
      const [updated] = await db
        .update(googleDriveConfigTable)
        .set({ folderId, driveId: validation.driveId, folderName: validation.name, updatedAt: new Date() })
        .where(eq(googleDriveConfigTable.id, existing.id))
        .returning();
      res.json(updated);
    } else {
      const [inserted] = await db
        .insert(googleDriveConfigTable)
        .values({ folderId, driveId: validation.driveId, folderName: validation.name })
        .returning();
      res.json(inserted);
    }
  } catch (err) {
    console.error("[drive-config] POST error:", err);
    res.status(500).json({ error: "Failed to save Drive configuration" });
  }
});

router.post("/settings/google-drive/test", async (req, res) => {
  let accessToken: string;
  try {
    accessToken = await getValidGoogleAccessToken(req.session);
  } catch (err) {
    if (err instanceof GoogleAuthError) {
      res.status(401).json({ ok: false, code: "expired_auth", error: "Google account not connected." });
      return;
    }
    res.status(500).json({ ok: false, error: "Authentication error" });
    return;
  }

  try {
    const [config] = await db.select().from(googleDriveConfigTable).limit(1);
    if (!config?.folderId) {
      res.status(400).json({ ok: false, error: "No folder configured." });
      return;
    }

    const validation = await validateFolder(config.folderId, accessToken);
    if (!validation.ok) {
      res.json({ ok: false, code: validation.code, error: validation.message });
      return;
    }

    if (validation.name !== config.folderName || validation.driveId !== config.driveId) {
      await db.update(googleDriveConfigTable)
        .set({ folderName: validation.name, driveId: validation.driveId, updatedAt: new Date() })
        .where(eq(googleDriveConfigTable.id, config.id));
    }

    res.json({ ok: true, folderName: validation.name, driveId: validation.driveId });
  } catch (err) {
    console.error("[drive-config] test error:", err);
    res.status(500).json({ ok: false, error: "Test failed" });
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
