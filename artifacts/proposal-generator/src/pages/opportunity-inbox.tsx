import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { RefreshCw, ExternalLink, CheckCircle2, X, Flame, Zap, Minus, ArrowRight, Loader2 } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";

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
  geographyScore?: number | null;
  geoRegion?: string | null;
  bahamasAdvantageScore?: number | null;
  confidence?: string | null;
  status: string;
  createdAt: string;
}

const STATUS_FILTERS = [
  { value: "all", label: "All" },
  { value: "new", label: "New" },
  { value: "saved", label: "Saved" },
  { value: "dismissed", label: "Dismissed" },
];

const GEO_FILTERS = [
  { value: "all", label: "All Regions" },
  { value: "bahamas", label: "🇧🇸 Bahamas" },
  { value: "caribbean", label: "🌴 Caribbean" },
  { value: "sids", label: "🏝️ SIDS" },
  { value: "global", label: "🌐 Global" },
];

const GEO_LABELS: Record<string, string> = {
  bahamas: "🇧🇸 Bahamas",
  caribbean: "🌴 Caribbean",
  sids: "🏝️ SIDS",
  latam: "🌎 Lat Am",
  global: "🌐 Global",
};

function ScoreBadge({ score, rec }: { score?: number | null; rec?: string | null }) {
  if (score == null) return <span className="text-muted-foreground text-xs">–</span>;
  const color =
    rec === "PURSUE"  ? "text-emerald-400 border-emerald-800 bg-emerald-900/20" :
    rec === "CONSIDER"? "text-yellow-400 border-yellow-800 bg-yellow-900/20" :
                        "text-gray-400 border-gray-700 bg-gray-900/20";
  const icon =
    rec === "PURSUE"   ? <Flame className="w-3 h-3" /> :
    rec === "CONSIDER" ? <Zap className="w-3 h-3" /> :
                         <Minus className="w-3 h-3" />;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-semibold ${color}`}>
      {icon}{score}
    </span>
  );
}

function ConfidenceBadge({ confidence }: { confidence?: string | null }) {
  if (!confidence || confidence === "LOW") return null;
  const color = confidence === "HIGH"
    ? "text-blue-400 border-blue-800 bg-blue-900/20"
    : "text-slate-400 border-slate-700 bg-slate-900/20";
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium ${color}`}>
      {confidence}
    </span>
  );
}

function GeoBadge({ region }: { region?: string | null }) {
  if (!region) return null;
  const label = GEO_LABELS[region];
  if (!label) return null;
  const isHighPrio = region === "bahamas" || region === "caribbean";
  return (
    <span className={`text-xs ${isHighPrio ? "text-amber-400 font-medium" : "text-muted-foreground"}`}>
      {label}
    </span>
  );
}

export default function OpportunityInbox() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [statusFilter, setStatusFilter] = useState("new");
  const [geoFilter, setGeoFilter] = useState("all");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [startingBid, setStartingBid] = useState<number | null>(null);

  const { data: rawItems = [], isLoading, isFetching } = useQuery<DiscoveredTender[]>({
    queryKey: ["discovered-tenders", statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      const r = await fetch(`${BASE}/api/discovered-tenders?${params}`);
      if (!r.ok) throw new Error("Failed to load");
      return r.json();
    },
  });

  // Client-side geo filter
  const items = geoFilter === "all"
    ? rawItems
    : rawItems.filter((i) => i.geoRegion === geoFilter);

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

  const startBid = async (item: DiscoveredTender) => {
    setStartingBid(item.id);
    try {
      const r = await fetch(`${BASE}/api/discovered-tenders/${item.id}/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!r.ok) throw new Error("Failed to promote");
      const result = await r.json() as { opportunityId: number };
      qc.invalidateQueries({ queryKey: ["discovered-tenders"] });
      navigate(`/opportunities/${result.opportunityId}`);
    } catch {
      toast({ title: "Could not start bid", variant: "destructive" });
    } finally {
      setStartingBid(null);
    }
  };

  const triggerCrawl = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${BASE}/api/tender-intelligence/crawl`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!r.ok) throw new Error("Failed to start");
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "Crawl started", description: "New opportunities will appear in ~2 minutes." });
      setTimeout(() => qc.invalidateQueries({ queryKey: ["discovered-tenders"] }), 90000);
    },
    onError: () => toast({ title: "Failed to start crawl", variant: "destructive" }),
  });

  const pursue  = rawItems.filter((i) => i.recommendation === "PURSUE").length;
  const consider = rawItems.filter((i) => i.recommendation === "CONSIDER").length;
  const bahamas  = rawItems.filter((i) => i.geoRegion === "bahamas").length;
  const caribbean = rawItems.filter((i) => i.geoRegion === "caribbean").length;

  return (
    <div className="p-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-8 gap-4">
        <div>
          <h1 className="text-4xl font-bold text-white mb-2 tracking-tight">Opportunity Inbox</h1>
          <p className="text-muted-foreground">Bahamas-first tender intelligence, scored for ONWRD fit.</p>
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

      {/* Summary cards */}
      {rawItems.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
          <div className="p-4 rounded-lg border border-emerald-900 bg-emerald-900/10 text-center">
            <div className="text-2xl font-bold text-emerald-400">{pursue}</div>
            <div className="text-xs text-muted-foreground mt-1">🔥 Pursue</div>
          </div>
          <div className="p-4 rounded-lg border border-yellow-900 bg-yellow-900/10 text-center">
            <div className="text-2xl font-bold text-yellow-400">{consider}</div>
            <div className="text-xs text-muted-foreground mt-1">⚡ Consider</div>
          </div>
          <div className="p-4 rounded-lg border border-amber-800/50 bg-amber-900/10 text-center">
            <div className="text-2xl font-bold text-amber-400">{bahamas}</div>
            <div className="text-xs text-muted-foreground mt-1">🇧🇸 Bahamas</div>
          </div>
          <div className="p-4 rounded-lg border border-teal-900/50 bg-teal-900/10 text-center">
            <div className="text-2xl font-bold text-teal-400">{caribbean}</div>
            <div className="text-xs text-muted-foreground mt-1">🌴 Caribbean</div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-4">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setStatusFilter(f.value)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
              statusFilter === f.value
                ? "bg-primary text-white border-primary"
                : "bg-card text-muted-foreground border-border hover:text-white"
            }`}
          >
            {f.label}
          </button>
        ))}
        <span className="mx-2 border-l border-border" />
        {GEO_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setGeoFilter(f.value)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
              geoFilter === f.value
                ? "bg-primary text-white border-primary"
                : "bg-card text-muted-foreground border-border hover:text-white"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* List */}
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
                item.recommendation === "PURSUE"  ? "border-emerald-900/60" :
                item.recommendation === "CONSIDER"? "border-yellow-900/60" :
                item.geoRegion === "bahamas"       ? "border-amber-900/40" :
                item.geoRegion === "caribbean"     ? "border-teal-900/40" :
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
                      <GeoBadge region={item.geoRegion} />
                      <ConfidenceBadge confidence={item.confidence} />
                      {item.sector && (
                        <Badge variant="outline" className="text-xs py-0 max-w-[200px] truncate">
                          {item.sector}
                        </Badge>
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

                  {/* Score breakdown */}
                  {(item.geographyScore != null || item.bahamasAdvantageScore != null) && (
                    <div className="flex gap-4 text-xs">
                      {item.geographyScore != null && (
                        <span className="text-muted-foreground">
                          Geography score: <span className="text-white font-medium">{item.geographyScore}/100</span>
                        </span>
                      )}
                      {item.bahamasAdvantageScore != null && (
                        <span className="text-muted-foreground">
                          Bahamas advantage: <span className="text-amber-400 font-medium">{item.bahamasAdvantageScore}/100</span>
                        </span>
                      )}
                    </div>
                  )}

                  {item.scoringReasoning && (
                    <div className="p-3 rounded bg-muted/20 border border-border text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">Scoring: </span>
                      {item.scoringReasoning}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    {item.deadline && <span>Deadline: {format(new Date(item.deadline), "MMM d, yyyy")}</span>}
                    {item.valueAmount && <span>· Value: {item.valueAmount}</span>}
                    <span>· Discovered {format(new Date(item.createdAt), "MMM d")}</span>
                  </div>

                  <div className="flex gap-2 flex-wrap items-center">
                    {/* Primary CTA for actionable opportunities */}
                    {(item.recommendation === "PURSUE" || item.recommendation === "CONSIDER") && (
                      <Button
                        size="sm"
                        onClick={() => startBid(item)}
                        disabled={startingBid === item.id}
                        className="h-7 px-3 text-xs bg-emerald-600 hover:bg-emerald-500 text-white gap-1.5"
                      >
                        {startingBid === item.id
                          ? <><Loader2 className="w-3 h-3 animate-spin" /> Starting…</>
                          : <><ArrowRight className="w-3 h-3" /> Start Bid</>}
                      </Button>
                    )}
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
                    {item.status !== "saved" && item.recommendation === "SKIP" && (
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
