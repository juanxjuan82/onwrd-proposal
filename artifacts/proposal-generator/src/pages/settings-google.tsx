import { useEffect, useState, useCallback } from "react";
import { GoogleConnect } from "@/components/google-connect";
import { Settings, FolderOpen, Info, Loader2, FolderCheck, AlertTriangle, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

interface DriveConfig {
  folderId: string | null;
  driveId: string | null;
  folderName: string | null;
}

interface GoogleStatus {
  connected: boolean;
  email: string | null;
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

declare global {
  interface Window {
    gapi: {
      load: (lib: string, cb: () => void) => void;
    };
    google: {
      picker: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        PickerBuilder: new () => any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        DocsView: new (viewId?: unknown) => any;
        ViewId: { FOLDERS: unknown };
        Action: { PICKED: string; CANCEL: string };
      };
    };
  }
}

interface PickerData {
  action: string;
  docs?: { id: string; name: string }[];
}

export default function SettingsGoogle() {
  const { toast } = useToast();
  const [driveConfig, setDriveConfig] = useState<DriveConfig | null>(null);
  const [googleStatus, setGoogleStatus] = useState<GoogleStatus | null>(null);
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [saving, setSaving] = useState(false);

  const fetchConfig = async () => {
    try {
      const [configRes, statusRes] = await Promise.all([
        fetch(`${BASE}/api/settings/google-drive`),
        fetch(`${BASE}/api/auth/google/status`),
      ]);
      if (configRes.ok) setDriveConfig((await configRes.json()) as DriveConfig);
      if (statusRes.ok) {
        const s = (await statusRes.json()) as GoogleStatus;
        setGoogleStatus(s);
      }
    } finally {
      setLoadingConfig(false);
    }
  };

  useEffect(() => {
    void fetchConfig();
  }, []);

  // Load the Google API loader script once
  useEffect(() => {
    if (document.getElementById("gapi-script")) return;
    const script = document.createElement("script");
    script.id = "gapi-script";
    script.src = "https://apis.google.com/js/api.js";
    script.async = true;
    document.body.appendChild(script);
  }, []);

  const handleFolderSelected = useCallback(async (folderId: string) => {
    setSaving(true);
    try {
      const res = await fetch(`${BASE}/api/settings/google-drive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderId }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
        throw new Error(err.error ?? "Failed to save folder");
      }
      const data = (await res.json()) as DriveConfig;
      setDriveConfig(data);
      toast({ title: "Folder saved", description: `Now exporting to "${data.folderName ?? folderId}"` });
    } catch (err) {
      toast({ title: "Could not save folder", description: (err as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }, [toast]);

  const openPicker = useCallback(async () => {
    setPickerLoading(true);
    try {
      // Fetch the access token from the backend session
      const tokenRes = await fetch(`${BASE}/api/auth/google/picker-token`);
      if (!tokenRes.ok) {
        const err = (await tokenRes.json().catch(() => ({}))) as { error?: string };
        toast({ title: "Cannot open folder picker", description: err.error ?? "Connect your Google account first.", variant: "destructive" });
        return;
      }
      const { accessToken } = (await tokenRes.json()) as { accessToken: string };

      const pickerApiKey = import.meta.env.VITE_GOOGLE_PICKER_API_KEY as string | undefined;
      const appId = import.meta.env.VITE_GOOGLE_CLOUD_PROJECT_NUMBER as string | undefined;

      if (!pickerApiKey || !appId) {
        toast({ title: "Picker not configured", description: "VITE_GOOGLE_PICKER_API_KEY and VITE_GOOGLE_CLOUD_PROJECT_NUMBER must be set.", variant: "destructive" });
        return;
      }

      if (!window.gapi) {
        toast({ title: "Google API not loaded", description: "Refresh the page and try again.", variant: "destructive" });
        return;
      }

      window.gapi.load("picker", () => {
        const google = window.google;

        const myDriveView = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
          .setIncludeFolders(true)
          .setSelectFolderEnabled(true)
          .setMimeTypes("application/vnd.google-apps.folder");

        const sharedDriveView = new google.picker.DocsView()
          .setEnableTeamDrives(true)
          .setIncludeFolders(true)
          .setSelectFolderEnabled(true)
          .setMimeTypes("application/vnd.google-apps.folder");

        const picker = new google.picker.PickerBuilder()
          .addView(myDriveView)
          .addView(sharedDriveView)
          .setOAuthToken(accessToken)
          .setDeveloperKey(pickerApiKey)
          .setAppId(appId)
          .setCallback((data: PickerData) => {
            if (data.action === google.picker.Action.PICKED && data.docs?.[0]) {
              void handleFolderSelected(data.docs[0].id);
            }
          })
          .build();

        picker.setVisible(true);
        setPickerLoading(false);
      });
    } catch {
      setPickerLoading(false);
      toast({ title: "Could not open folder picker", description: "An unexpected error occurred.", variant: "destructive" });
    }
  }, [handleFolderSelected, toast]);

  const handleTest = async () => {
    setTesting(true);
    try {
      const res = await fetch(`${BASE}/api/settings/google-drive/test`, { method: "POST" });
      const data = (await res.json()) as { ok: boolean; error?: string; folderName?: string };
      if (data.ok) {
        if (data.folderName) {
          setDriveConfig((prev) => prev ? { ...prev, folderName: data.folderName! } : prev);
        }
        toast({ title: "Connection verified", description: `Folder "${data.folderName ?? ""}" is accessible and writable.` });
      } else {
        toast({ title: "Test failed", description: data.error ?? "Could not verify folder access.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Test failed", description: "Could not reach the server.", variant: "destructive" });
    } finally {
      setTesting(false);
    }
  };

  const handleClear = async () => {
    setClearing(true);
    try {
      const res = await fetch(`${BASE}/api/settings/google-drive`, { method: "DELETE" });
      if (!res.ok) throw new Error("Clear failed");
      setDriveConfig({ folderId: null, driveId: null, folderName: null });
      toast({ title: "Folder cleared", description: "No destination folder is configured." });
    } catch {
      toast({ title: "Clear failed", description: "Could not clear the folder configuration.", variant: "destructive" });
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
            {googleStatus?.connected && googleStatus.email && (
              <p className="text-sm text-muted-foreground mb-3">
                Connected as <span className="text-foreground font-medium">{googleStatus.email}</span>
              </p>
            )}
            <p className="text-sm text-muted-foreground mb-4">
              Connect your Google account to share proposals to Google Docs. Documents are created with the permissions of the destination folder — no public link sharing.
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
              All proposals shared for team review are placed in this Google Drive folder. A folder must be configured before the first handoff.
            </p>

            {loadingConfig ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" /> Loading…
              </div>
            ) : driveConfig?.folderId ? (
              <div className="space-y-3">
                <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/40 border">
                  <FolderCheck className="w-4 h-4 text-green-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">
                      {driveConfig.folderName ?? driveConfig.folderId}
                    </p>
                    <p className="text-xs text-muted-foreground font-mono truncate">{driveConfig.folderId}</p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void openPicker()}
                    disabled={pickerLoading || saving || !googleStatus?.connected}
                    title={!googleStatus?.connected ? "Connect your Google account first" : undefined}
                  >
                    {pickerLoading || saving ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <FolderOpen className="w-4 h-4 mr-1.5" />}
                    Change Folder
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void handleTest()}
                    disabled={testing}
                  >
                    {testing ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1.5" />}
                    Test Connection
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={() => void handleClear()}
                    disabled={clearing}
                  >
                    {clearing ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <X className="w-4 h-4 mr-1.5" />}
                    Clear Folder
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {!googleStatus?.connected && (
                  <div className="flex items-center gap-2 p-3 rounded-lg bg-orange-900/10 border border-orange-900/30 text-sm text-orange-400">
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    Connect your Google account above before choosing a folder.
                  </div>
                )}
                <Button
                  size="sm"
                  onClick={() => void openPicker()}
                  disabled={pickerLoading || !googleStatus?.connected}
                  title={!googleStatus?.connected ? "Connect your Google account first" : undefined}
                >
                  {pickerLoading ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <FolderOpen className="w-4 h-4 mr-1.5" />}
                  Choose Google Drive Folder
                </Button>
              </div>
            )}
          </div>
        </section>

        {/* Handoff Model */}
        <section className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center">
              <Info className="w-4 h-4 text-primary" />
            </div>
            <h2 className="text-lg font-semibold">How Sharing Works</h2>
          </div>

          <div className="p-5 rounded-lg border bg-card space-y-4 text-sm">
            <div className="flex gap-3">
              <div className="w-2 h-2 rounded-full bg-primary mt-1.5 flex-shrink-0" />
              <div>
                <p className="font-medium mb-0.5">One document per proposal</p>
                <p className="text-muted-foreground">The first "Share for Team Review" creates the Google Doc and writes the proposal content. That document is then canonical — subsequent requests open the same document without overwriting it.</p>
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
                <p className="font-medium mb-0.5">Folder required before first handoff</p>
                <p className="text-muted-foreground">The Share action is disabled until a destination folder is configured here. Documents are never created in the Drive root.</p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
