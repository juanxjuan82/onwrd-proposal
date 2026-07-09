import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { RefreshCw, Trash2, Play, CheckCircle2, XCircle, Clock } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface TenderSource {
  id: number;
  name: string;
  sourceType: string;
  url: string;
  adapterType: string;
  active: boolean;
  lastCheckedAt?: string | null;
  lastSuccessAt?: string | null;
  itemsFoundCount: number;
}

interface CrawlerRun {
  id: number;
  sourceId: number;
  startedAt: string;
  completedAt?: string | null;
  status: string;
  itemsFound: number;
  itemsNew: number;
  errorMessage?: string | null;
}

interface SearchProfile {
  id: number;
  name: string;
  description: string;
  keywords: string;
  excludedKeywords: string;
  active: boolean;
}

function SourceTypeLabel({ type }: { type: string }) {
  const map: Record<string, string> = {
    government: "Government",
    un: "United Nations",
    development_bank: "Dev Bank",
    ngo: "NGO",
    other: "Other",
  };
  return <span>{map[type] ?? type}</span>;
}

export default function SettingsSources() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"sources" | "profiles" | "runs">("sources");

  const { data: sources = [], isLoading: sourcesLoading } = useQuery<TenderSource[]>({
    queryKey: ["tender-sources"],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/tender-sources`);
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
  });

  const { data: runs = [] } = useQuery<CrawlerRun[]>({
    queryKey: ["crawler-runs"],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/crawler-runs`);
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    enabled: tab === "runs",
  });

  const { data: profiles = [] } = useQuery<SearchProfile[]>({
    queryKey: ["tender-search-profiles"],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/tender-search-profiles`);
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    enabled: tab === "profiles",
  });

  const toggleSource = useMutation({
    mutationFn: async ({ id, active }: { id: number; active: boolean }) => {
      const r = await fetch(`${BASE}/api/tender-sources/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active }),
      });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tender-sources"] }),
  });

  const deleteSource = useMutation({
    mutationFn: async (id: number) => {
      await fetch(`${BASE}/api/tender-sources/${id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tender-sources"] });
      toast({ title: "Source removed" });
    },
  });

  const crawlSource = useMutation({
    mutationFn: async (sourceId: number) => {
      const r = await fetch(`${BASE}/api/tender-intelligence/crawl`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId }),
      });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "Crawl started", description: "Results will appear in the Inbox in ~1 minute." });
      setTimeout(() => qc.invalidateQueries({ queryKey: ["crawler-runs"] }), 30000);
    },
  });

  const toggleProfile = useMutation({
    mutationFn: async ({ id, active }: { id: number; active: boolean }) => {
      const r = await fetch(`${BASE}/api/tender-search-profiles/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active }),
      });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tender-search-profiles"] }),
  });

  const TABS = [
    { value: "sources", label: "Sources" },
    { value: "profiles", label: "Search Profiles" },
    { value: "runs", label: "Run History" },
  ] as const;

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="mb-8">
        <h1 className="text-4xl font-bold text-white mb-2 tracking-tight">Tender Intelligence</h1>
        <p className="text-muted-foreground">Manage sources, search profiles, and crawl history.</p>
      </div>

      <div className="flex gap-1 mb-6 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.value}
            onClick={() => setTab(t.value)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === t.value
                ? "border-primary text-white"
                : "border-transparent text-muted-foreground hover:text-white"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "sources" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm text-muted-foreground">{sources.filter((s) => s.active).length} of {sources.length} sources active</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => crawlSource.mutate(undefined as unknown as number)}
              disabled={crawlSource.isPending}
            >
              <Play className="w-3.5 h-3.5 mr-1.5" />
              Run All Now
            </Button>
          </div>

          {sourcesLoading ? (
            [1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full rounded-lg" />)
          ) : (
            sources.map((s) => (
              <div key={s.id} className="flex items-center gap-4 p-4 rounded-lg border border-border bg-card">
                <Switch
                  checked={s.active}
                  onCheckedChange={(active) => toggleSource.mutate({ id: s.id, active })}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="font-medium text-sm text-white">{s.name}</span>
                    <Badge variant="outline" className="text-xs py-0"><SourceTypeLabel type={s.sourceType} /></Badge>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span>{s.itemsFoundCount} found total</span>
                    {s.lastCheckedAt && (
                      <span>· Last checked {formatDistanceToNow(new Date(s.lastCheckedAt), { addSuffix: true })}</span>
                    )}
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => crawlSource.mutate(s.id)}
                    disabled={crawlSource.isPending}
                    title="Run now"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => deleteSource.mutate(s.id)}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {tab === "profiles" && (
        <div className="space-y-3">
          {profiles.map((p) => (
            <div key={p.id} className="p-4 rounded-lg border border-border bg-card">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <Switch
                      checked={p.active}
                      onCheckedChange={(active) => toggleProfile.mutate({ id: p.id, active })}
                    />
                    <span className="font-medium text-sm text-white">{p.name}</span>
                  </div>
                  <p className="text-xs text-muted-foreground mb-2">{p.description}</p>
                  <div className="flex flex-wrap gap-1">
                    {(JSON.parse(p.keywords) as string[]).map((kw) => (
                      <span key={kw} className="px-2 py-0.5 rounded-full bg-primary/10 text-primary text-xs border border-primary/20">{kw}</span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "runs" && (
        <div className="space-y-2">
          {runs.length === 0 ? (
            <p className="text-muted-foreground text-sm py-8 text-center">No crawl runs yet. Trigger one from the Inbox or a source.</p>
          ) : (
            runs.map((run) => {
              const src = sources.find((s) => s.id === run.sourceId);
              return (
                <div key={run.id} className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card text-sm">
                  {run.status === "success" ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                  ) : run.status === "failed" ? (
                    <XCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                  ) : (
                    <Clock className="w-4 h-4 text-yellow-400 flex-shrink-0" />
                  )}
                  <span className="font-medium text-white flex-1">{src?.name ?? `Source #${run.sourceId}`}</span>
                  <span className="text-muted-foreground text-xs">{run.itemsNew} new</span>
                  <span className="text-muted-foreground text-xs">
                    {formatDistanceToNow(new Date(run.startedAt), { addSuffix: true })}
                  </span>
                  {run.errorMessage && (
                    <span className="text-red-400 text-xs truncate max-w-[200px]" title={run.errorMessage}>
                      {run.errorMessage}
                    </span>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
