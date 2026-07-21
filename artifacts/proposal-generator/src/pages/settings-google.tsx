import { useEffect, useState } from "react";
import { GoogleConnect } from "@/components/google-connect";
import { Settings, FolderOpen, Info, Save, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

interface DriveConfig {
  folderId: string | null;
  driveId: string | null;
  folderName: string | null;
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function SettingsGoogle() {
  const { toast } = useToast();

  const [driveConfig, setDriveConfig] = useState<DriveConfig | null>(null);
  const [folderId, setFolderId] = useState("");
  const [folderName, setFolderName] = useState("");
  const [driveId, setDriveId] = useState("");
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [loadingConfig, setLoadingConfig] = useState(true);

  const fetchConfig = async () => {
    try {
      const res = await fetch(`${BASE}/api/settings/google-drive`);
      if (res.ok) {
        const data = (await res.json()) as DriveConfig;
        setDriveConfig(data);
        setFolderId(data.folderId ?? "");
        setFolderName(data.folderName ?? "");
        setDriveId(data.driveId ?? "");
      }
    } catch {
      // ignore
    } finally {
      setLoadingConfig(false);
    }
  };

  useEffect(() => {
    void fetchConfig();
  }, []);

  const handleSave = async () => {
    if (!folderId.trim()) {
      toast({ title: "Folder ID required", description: "Paste the folder ID from your Google Drive folder URL.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${BASE}/api/settings/google-drive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          folderId: folderId.trim(),
          folderName: folderName.trim() || undefined,
          driveId: driveId.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(errData.error || "Save failed");
      }
      const data = (await res.json()) as DriveConfig;
      setDriveConfig(data);
      setFolderName(data.folderName ?? folderName);
      toast({ title: "Drive folder saved", description: "Exports will be placed in this folder." });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not save the Drive configuration.";
      toast({ title: "Save failed", description: msg, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setClearing(true);
    try {
      const res = await fetch(`${BASE}/api/settings/google-drive`, { method: "DELETE" });
      if (!res.ok) throw new Error("Clear failed");
      setDriveConfig({ folderId: null, driveId: null, folderName: null });
      setFolderId("");
      setFolderName("");
      toast({ title: "Drive folder cleared", description: "Exports will be saved to your Drive root." });
    } catch {
      toast({ title: "Clear failed", description: "Could not clear the Drive configuration.", variant: "destructive" });
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <div className="mb-8">
        <h1 className="text-4xl font-bold text-white mb-2 tracking-tight">Settings</h1>
        <p className="text-muted-foreground">Manage integrations and export configuration.</p>
      </div>

      <div className="space-y-6">
        {/* Google Account */}
        <section className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center">
              <Settings className="w-4 h-4 text-primary" />
            </div>
            <h2 className="text-lg font-semibold">Google Account</h2>
          </div>

          <div className="p-5 rounded-lg border bg-card">
            <p className="text-sm text-muted-foreground mb-4">
              Connect your Google account to export proposals to Google Docs. Exports are placed in your Drive with the permissions of the destination folder — no public link sharing.
            </p>
            <GoogleConnect />
          </div>
        </section>

        {/* Drive Destination Folder */}
        <section className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center">
              <FolderOpen className="w-4 h-4 text-primary" />
            </div>
            <h2 className="text-lg font-semibold">Drive Destination Folder</h2>
          </div>

          <div className="p-5 rounded-lg border bg-card space-y-4">
            <p className="text-sm text-muted-foreground">
              All exported proposals are placed in this Google Drive folder. Leave blank to save to your Drive root.
            </p>

            {loadingConfig ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading…
              </div>
            ) : (
              <div className="space-y-3">
                {driveConfig?.folderId && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground p-2 rounded bg-muted/50">
                    <span className="font-medium text-foreground">Current:</span>
                    <code className="font-mono truncate max-w-xs">{driveConfig.folderId}</code>
                    {driveConfig.folderName && <span className="text-muted-foreground shrink-0">({driveConfig.folderName})</span>}
                  </div>
                )}

                <div className="space-y-1.5">
                  <Label htmlFor="folder-id">Folder ID</Label>
                  <Input
                    id="folder-id"
                    value={folderId}
                    onChange={(e) => setFolderId(e.target.value)}
                    placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms"
                    className="font-mono text-xs"
                  />
                  <p className="text-xs text-muted-foreground">
                    Copy the ID from your Google Drive folder URL:{" "}
                    <code className="bg-muted px-1 rounded">drive.google.com/drive/folders/&lt;FOLDER_ID&gt;</code>
                  </p>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="folder-name">Display name <span className="text-muted-foreground font-normal">(optional — auto-filled on save)</span></Label>
                  <Input
                    id="folder-name"
                    value={folderName}
                    onChange={(e) => setFolderName(e.target.value)}
                    placeholder="e.g. ONWRD Proposals 2026"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="drive-id">Shared Drive ID <span className="text-muted-foreground font-normal">(optional — only needed for Shared Drives)</span></Label>
                  <Input
                    id="drive-id"
                    value={driveId}
                    onChange={(e) => setDriveId(e.target.value)}
                    placeholder="Leave blank for personal Drive"
                    className="font-mono text-xs"
                  />
                  <p className="text-xs text-muted-foreground">
                    For a Shared Drive folder, copy the Drive ID from{" "}
                    <code className="bg-muted px-1 rounded">drive.google.com/drive/u/0/folders/&lt;FOLDER_ID&gt;</code>{" "}
                    — it is the ID shown in the URL when you navigate to the Shared Drive root, not the folder.
                  </p>
                </div>

                <div className="flex gap-2 pt-1">
                  <Button size="sm" onClick={handleSave} disabled={saving || clearing}>
                    {saving ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Save className="w-4 h-4 mr-1.5" />}
                    Save Folder
                  </Button>
                  {driveConfig?.folderId && (
                    <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={handleClear} disabled={saving || clearing}>
                      {clearing ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Trash2 className="w-4 h-4 mr-1.5" />}
                      Clear
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Export Behaviour */}
        <section className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center">
              <Info className="w-4 h-4 text-primary" />
            </div>
            <h2 className="text-lg font-semibold">Export Behaviour</h2>
          </div>

          <div className="p-5 rounded-lg border bg-card space-y-4 text-sm">
            <div className="flex gap-3">
              <div className="w-2 h-2 rounded-full bg-primary mt-1.5 flex-shrink-0" />
              <div>
                <p className="font-medium mb-0.5">One canonical document per proposal</p>
                <p className="text-muted-foreground">The first export creates the Google Doc. Subsequent exports sync the latest content back into the same document — no duplicates.</p>
              </div>
            </div>
            <div className="flex gap-3">
              <div className="w-2 h-2 rounded-full bg-primary mt-1.5 flex-shrink-0" />
              <div>
                <p className="font-medium mb-0.5">Inherited permissions</p>
                <p className="text-muted-foreground">Documents are never shared publicly. Access is inherited from the destination folder — manage permissions directly in Google Drive.</p>
              </div>
            </div>
            <div className="flex gap-3">
              <div className="w-2 h-2 rounded-full bg-primary mt-1.5 flex-shrink-0" />
              <div>
                <p className="font-medium mb-0.5">Section-based export</p>
                <p className="text-muted-foreground">When a proposal has been generated from an opportunity with individual sections, those sections become distinct chapters in the document.</p>
              </div>
            </div>
            <div className="flex gap-3">
              <div className="w-2 h-2 rounded-full bg-primary mt-1.5 flex-shrink-0" />
              <div>
                <p className="font-medium mb-0.5">Manual export only</p>
                <p className="text-muted-foreground">Proposals are never exported automatically. Use the Export or Sync button on the proposal page when you're ready.</p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
