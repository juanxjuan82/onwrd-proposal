import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { RefreshCw, ExternalLink, CheckCircle2, X, Flame, Zap, Minus } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { useLocation } from "wouter";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface DiscoveredTender {
  id: number;
  sourceId: number;
  title: string;
  organization: string;
  url?: string | null;
  deadline?: string | null;
  description: string;
  country?: string | null;
  sector?: string | null;
  valueAmount?: string | null;
  fitScore?: number | null;
  recommendation?: string | null;
  scoringReasoning?: string | null;
  status: string;
  createdAt: string;
}

const FILTERS = [
  { value: "all", label: "All" },
  { value: "new", label: "New" },
  { value: "saved", label: "Saved" },
  { value: "dismissed", label: "Dismissed" },
];

const SCORE_FILTERS = [
  { value: "all", label: "All Scores" },
  { value: "70", label: "70+ (Strong)" },
  { value: "50", label: "50+ (Relevant)" },
];

function ScoreBadge({ score, rec }: { score?: number | null; rec?: string | null }) {
  if (score == null) return <span className="text-muted-foreground text-xs">–</span>;
  const color =
    rec === "PURSUE" ? "text-emerald-400 border-emerald-800 bg-emerald-900/20" :
    rec === "CONSIDER" ? "text-yellow-400 border-yellow-800 bg-yellow-900/20" :
    "text-gray-400 border-gray-700 bg-gray-900/20";
  const icon = rec === "PURSUE" ? <Flame className="w-3 h-3" /> : rec === "CONSIDER" ? <Zap className="w-3 h-3" /> : <Minus className="w-3 h-3" />;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-semibold ${color}`}>
      {icon}{score}
    </span>
  );
}

export default function OpportunityInbox() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [filter, setFilter] = useState("new");
  const [minScore, setMinScore] = useState("all");
  const [expanded, setExpanded] = useState<number | null>(null);

  const { data: items = [], isLoading, isFetching } = useQuery<DiscoveredTender[]>({
    queryKey: ["discovered-tenders", filter, minScore],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filter !== "all") params.set("status", filter);
      if (minScore !== "all") params.set("minScore", minScore);
      const r = await fetch(`${BASE}/api/discovered-tenders?${params}`);
      if (!r.ok) throw new Error("Failed to load");
      return r.json();
    },
  });

  const updateStatus = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: string }) => {
      const r = await fetch(`${BASE}/api/discovered-tenders/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!r.ok) throw new Error("Failed to update");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["discovered-tenders"] }),
    onError: () => toast({ title: "Update failed", variant: "destructive" }),
  });

  const triggerCrawl = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${BASE}/api/tender-intelligence/crawl`, { method: "POST" });
      if (!r.ok) throw new Error("Failed to start");
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "Crawl started", description: "New opportunities will appear in ~2 minutes." });
      setTimeout(() => qc.invalidateQueries({ queryKey: ["discovered-tenders"] }), 90000);
    },
    onError: () => toast({ title: "Failed to start crawl", variant: "destructive" }),
  });

  const pursue = items.filter((i) => i.recommendation === "PURSUE").length;
  const consider = items.filter((i) => i.recommendation === "CONSIDER").length;

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-8 gap-4">
        <div>
          <h1 className="text-4xl font-bold text-white mb-2 tracking-tight">Opportunity Inbox</h1>
          <p className="text-muted-foreground">AI-discovered procurement opportunities, scored for ONWRD fit.</p>
        </div>
        <Button
          variant="outline"
          onClick={() => triggerCrawl.mutate()}
          disabled={triggerCrawl.isPending}
        >
          <RefreshCw className={`w-4 h-4 mr-2 ${triggerCrawl.isPending ? "animate-spin" : ""}`} />
          {triggerCrawl.isPending ? "Starting…" : "Run Now"}
        </Button>
      </div>

      {items.length > 0 && (
        <div className="grid grid-cols-3 gap-4 mb-8">
          <div className="p-4 rounded-lg border border-emerald-900 bg-emerald-900/10 text-center">
            <div className="text-2xl font-bold text-emerald-400">{pursue}</div>
            <div className="text-xs text-muted-foreground mt-1">Pursue</div>
          </div>
          <div className="p-4 rounded-lg border border-yellow-900 bg-yellow-900/10 text-center">
            <div className="text-2xl font-bold text-yellow-400">{consider}</div>
            <div className="text-xs text-muted-foreground mt-1">Consider</div>
          </div>
          <div className="p-4 rounded-lg border border-border bg-card text-center">
            <div className="text-2xl font-bold text-white">{items.length}</div>
            <div className="text-xs text-muted-foreground mt-1">Total shown</div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2 mb-4">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
              filter === f.value
                ? "bg-primary text-white border-primary"
                : "bg-card text-muted-foreground border-border hover:text-white"
            }`}
          >
            {f.label}
          </button>
        ))}
        <span className="mx-2 border-l border-border" />
        {SCORE_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setMinScore(f.value)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
              minScore === f.value
                ? "bg-primary text-white border-primary"
                : "bg-card text-muted-foreground border-border hover:text-white"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-24 w-full rounded-lg" />)}
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-20 border border-dashed rounded-lg bg-card/50">
          <div className="text-4xl mb-4">📭</div>
          <h3 className="text-lg font-medium text-white mb-2">No opportunities yet</h3>
          <p className="text-muted-foreground mb-6 max-w-sm mx-auto">
            Click <strong>Run Now</strong> to trigger your first crawl, or wait for the daily 6am run.
          </p>
          <Button onClick={() => triggerCrawl.mutate()} disabled={triggerCrawl.isPending}>
            <RefreshCw className={`w-4 h-4 mr-2 ${triggerCrawl.isPending ? "animate-spin" : ""}`} />
            Run Now
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <div
              key={item.id}
              className={`border rounded-lg bg-card transition-all ${
                item.recommendation === "PURSUE" ? "border-emerald-900/60" :
                item.recommendation === "CONSIDER" ? "border-yellow-900/60" :
                "border-border"
              }`}
            >
              <div
                className="p-4 cursor-pointer"
                onClick={() => setExpanded(expanded === item.id ? null : item.id)}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <ScoreBadge score={item.fitScore} rec={item.recommendation} />
                      {item.country && (
                        <span className="text-xs text-muted-foreground">{item.country}</span>
                      )}
                      {item.sector && (
                        <Badge variant="outline" className="text-xs py-0">{item.sector}</Badge>
                      )}
                    </div>
                    <h3 className="font-medium text-white text-sm leading-snug">{item.title}</h3>
                    <p className="text-xs text-muted-foreground mt-0.5">{item.organization}</p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {item.deadline && (
                      <span className="text-xs text-muted-foreground hidden sm:block">
                        {formatDistanceToNow(new Date(item.deadline), { addSuffix: true })}
                      </span>
                    )}
                    {item.status === "new" && (
                      <div className="flex gap-1">
                        <button
                          title="Save"
                          onClick={(e) => { e.stopPropagation(); updateStatus.mutate({ id: item.id, status: "saved" }); }}
                          className="p-1.5 rounded hover:bg-emerald-900/30 text-emerald-400 transition-colors"
                        >
                          <CheckCircle2 className="w-4 h-4" />
                        </button>
                        <button
                          title="Dismiss"
                          onClick={(e) => { e.stopPropagation(); updateStatus.mutate({ id: item.id, status: "dismissed" }); }}
                          className="p-1.5 rounded hover:bg-red-900/30 text-red-400 transition-colors"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {expanded === item.id && (
                <div className="px-4 pb-4 border-t border-border/50 pt-3 space-y-3">
                  <p className="text-sm text-muted-foreground leading-relaxed">{item.description}</p>
                  {item.scoringReasoning && (
                    <div className="p-3 rounded bg-muted/20 border border-border text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">AI Reasoning: </span>
                      {item.scoringReasoning}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    {item.deadline && <span>Deadline: {format(new Date(item.deadline), "MMM d, yyyy")}</span>}
                    {item.valueAmount && <span>· Value: {item.valueAmount}</span>}
                    <span>· Discovered {format(new Date(item.createdAt), "MMM d")}</span>
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    {item.url && (
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                        View Original
                      </a>
                    )}
                    {item.status !== "saved" && (
                      <button
                        onClick={() => updateStatus.mutate({ id: item.id, status: "saved" })}
                        className="inline-flex items-center gap-1.5 text-xs text-emerald-400 hover:underline"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        Save
                      </button>
                    )}
                    {item.status !== "dismissed" && (
                      <button
                        onClick={() => updateStatus.mutate({ id: item.id, status: "dismissed" })}
                        className="inline-flex items-center gap-1.5 text-xs text-red-400 hover:underline"
                      >
                        <X className="w-3.5 h-3.5" />
                        Dismiss
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {isFetching && !isLoading && (
        <p className="text-xs text-muted-foreground text-center mt-4">Refreshing…</p>
      )}
    </div>
  );
}
