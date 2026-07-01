import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { LogIn, LogOut, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";

interface GoogleStatus {
  configured: boolean;
  connected: boolean;
  email: string | null;
  callbackUrl: string;
}

export function GoogleConnect() {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);
  const [location] = useLocation();
  const { toast } = useToast();

  const fetchStatus = async () => {
    try {
      const res = await fetch("/api/auth/google/status");
      if (res.ok) setStatus(await res.json());
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchStatus();
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("google_connected") === "1") {
      void fetchStatus();
      toast({ title: "Google Account connected", description: "Your proposals will now export to your Google Drive." });
      window.history.replaceState({}, "", window.location.pathname);
    }
    if (params.get("google_error") === "1") {
      toast({ title: "Connection failed", description: "Could not connect your Google Account. Please try again.", variant: "destructive" });
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [location]);

  const handleConnect = () => {
    window.location.href = `/api/auth/google?returnTo=${encodeURIComponent(window.location.pathname)}`;
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await fetch("/api/auth/google/disconnect", { method: "POST" });
      await fetchStatus();
      toast({ title: "Disconnected", description: "Your Google Account has been disconnected." });
    } finally {
      setDisconnecting(false);
    }
  };

  if (loading) return null;
  if (!status?.configured) return null;

  return (
    <div className="border-t border-border pt-4 mt-4">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Google Account</p>

      {status.connected ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-foreground">
            <CheckCircle2 className="w-3.5 h-3.5 text-green-500 shrink-0" />
            <span className="truncate">{status.email ?? "Connected"}</span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-xs text-muted-foreground h-7 px-2 gap-2"
            onClick={handleDisconnect}
            disabled={disconnecting}
          >
            {disconnecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LogOut className="w-3.5 h-3.5" />}
            Disconnect
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span>Not connected</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-start text-xs h-7 px-2 gap-2"
            onClick={handleConnect}
          >
            <LogIn className="w-3.5 h-3.5" />
            Connect Google
          </Button>
        </div>
      )}
    </div>
  );
}
