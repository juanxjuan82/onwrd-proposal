import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Loader2, Globe, Upload, Clock, ExternalLink, Sparkles,
  RotateCcw, Share2, FileText, AlertCircle, ChevronRight,
} from "lucide-react";
import { format } from "date-fns";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// ── Types ────────────────────────────────────────────────────────────────────
interface WorkspaceProposal {
  id: number;
  generationStatus: string | null;
  status: string;
  syncStatus: string | null;
  googleDocUrl: string | null;
  googleFileId: string | null;
  updatedAt: string | null;
}

interface WorkspaceItem {
  id: number;
  title: string;
  agency: string;
  category: string;
  status: string;
  sourceType: string | null;
  deadline: string | null;
  valueAmount: string | null;
  sourceUrl: string | null;
  updatedAt: string;
  createdAt: string;
  proposalId: number | null;
  proposal: WorkspaceProposal | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function sourceBadge(sourceType: string | null) {
  switch (sourceType) {
    case "crawler":
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-blue-900/50 bg-blue-950/30 px-2 py-0.5 text-[10px] text-blue-400">
          <Globe className="w-2.5 h-2.5" /> Scraped
        </span>
      );
    case "rfp_upload":
    case "url":
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-violet-900/50 bg-violet-950/30 px-2 py-0.5 text-[10px] text-violet-400">
          <Upload className="w-2.5 h-2.5" /> Uploaded
        </span>
      );
    case "pasted_text":
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-amber-900/50 bg-amber-950/30 px-2 py-0.5 text-[10px] text-amber-400">
          <FileText className="w-2.5 h-2.5" /> Pasted
        </span>
      );
    case "prospect_intake":
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-900/50 bg-emerald-950/30 px-2 py-0.5 text-[10px] text-emerald-400">
          <FileText className="w-2.5 h-2.5" /> Intake
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1 rounded-full border border-zinc-700/50 bg-zinc-900/30 px-2 py-0.5 text-[10px] text-zinc-500">
          <Clock className="w-2.5 h-2.5" /> Manual
        </span>
      );
  }
}

function generationStatusLabel(genStatus: string | null, proposalStatus: string): { label: string; color: string } | null {
  switch (genStatus) {
    case "extracting":
      return { label: "Extracting requirements…", color: "text-blue-400" };
    case "strategizing":
      return { label: "Building strategy…", color: "text-violet-400" };
    case "drafting":
      return { label: "Writing draft…", color: "text-amber-400" };
    case "failed":
      return { label: "Generation failed", color: "text-red-400" };
    case "ready":
      return null; // show action button instead
    default:
      if (proposalStatus === "proposal_drafting") {
        return { label: "Generating…", color: "text-yellow-400" };
      }
      return null;
  }
}

function isActiveGeneration(item: WorkspaceItem): boolean {
  const gs = item.proposal?.generationStatus;
  return gs === "extracting" || gs === "strategizing" || gs === "drafting" ||
    item.proposal?.status === "proposal_drafting";
}

function isHandoffComplete(proposal: WorkspaceProposal | null): boolean {
  if (!proposal) return false;
  if (proposal.syncStatus === "handoff_complete") return true;
  if (proposal.googleFileId &&
    proposal.syncStatus !== "pending_first_write" &&
    proposal.syncStatus !== "handoff_in_progress") {
    return true;
  }
  return false;
}

function isReady(proposal: WorkspaceProposal | null): boolean {
  if (!proposal) return false;
  const gs = proposal.generationStatus;
  if (gs === "ready") return true;
  if (!gs && (proposal.status === "ready_for_review" || proposal.status === "needs_onwrd_input" || proposal.status === "approved_for_export")) return true;
  return false;
}

// ── Action button ────────────────────────────────────────────────────────────
function ActionCell({
  item,
  onGenerate,
  generating,
}: {
  item: WorkspaceItem;
  onGenerate: (id: number) => void;
  generating: boolean;
}) {
  const [, setLocation] = useLocation();
  const { proposal } = item;

  // Handoff complete → Open Google Doc
  if (proposal && isHandoffComplete(proposal) && proposal.googleDocUrl) {
    return (
      <a
        href={proposal.googleDocUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 text-xs text-emerald-400 border border-emerald-800/50 bg-emerald-950/30 rounded-md px-3 py-1.5 hover:bg-emerald-900/40 transition-colors whitespace-nowrap"
        onClick={(e) => e.stopPropagation()}
      >
        <ExternalLink className="w-3.5 h-3.5" />
        Open Google Doc
      </a>
    );
  }

  // Ready → open proposal desk
  if (proposal && isReady(proposal)) {
    return (
      <Button
        size="sm"
        className="gap-1.5 text-xs bg-primary hover:bg-primary/90 whitespace-nowrap"
        onClick={(e) => { e.stopPropagation(); setLocation(`/proposals/${proposal.id}`); }}
      >
        <Share2 className="w-3.5 h-3.5" />
        Open Proposal
      </Button>
    );
  }

  // Active generation → spinner + status text
  if (proposal && isActiveGeneration(item)) {
    const info = generationStatusLabel(proposal.generationStatus, proposal.status);
    return (
      <span className={`inline-flex items-center gap-1.5 text-xs ${info?.color ?? "text-muted-foreground"} whitespace-nowrap`}>
        <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
        {info?.label ?? "Generating…"}
      </span>
    );
  }

  // Failed → Retry
  if (proposal?.generationStatus === "failed") {
    return (
      <Button
        size="sm"
        variant="outline"
        className="gap-1.5 text-xs border-red-800 text-red-400 hover:bg-red-950/30 whitespace-nowrap"
        onClick={(e) => { e.stopPropagation(); onGenerate(item.id); }}
        disabled={generating}
      >
        {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
        Retry
      </Button>
    );
  }

  // Has existing proposal but not generated → show Open Proposal link
  if (proposal && proposal.id && proposal.status !== "draft") {
    return (
      <Button
        size="sm"
        variant="outline"
        className="gap-1.5 text-xs whitespace-nowrap"
        onClick={(e) => { e.stopPropagation(); setLocation(`/proposals/${proposal.id}`); }}
      >
        <ChevronRight className="w-3.5 h-3.5" />
        Open Proposal
      </Button>
    );
  }

  // Idle → Generate Proposal
  return (
    <Button
      size="sm"
      className="gap-1.5 text-xs bg-[#0000FF] hover:bg-[#0000dd] whitespace-nowrap"
      onClick={(e) => { e.stopPropagation(); onGenerate(item.id); }}
      disabled={generating}
    >
      {generating ? (
        <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Starting…</>
      ) : (
        <><Sparkles className="w-3.5 h-3.5" /> Generate Proposal</>
      )}
    </Button>
  );
}

// ── Item card ─────────────────────────────────────────────────────────────────
function WorkspaceCard({
  item,
  onGenerate,
  generatingId,
}: {
  item: WorkspaceItem;
  onGenerate: (id: number) => void;
  generatingId: number | null;
}) {
  const [, setLocation] = useLocation();
  const generating = generatingId === item.id;

  const handleCardClick = () => {
    if (item.proposal?.id) {
      setLocation(`/proposals/${item.proposal.id}`);
    }
  };

  return (
    <div
      className={`group bg-card border rounded-lg transition-colors ${item.proposal?.id ? "hover:border-primary/40 cursor-pointer" : ""}`}
      onClick={item.proposal?.id ? handleCardClick : undefined}
    >
      <div className="flex items-center gap-4 px-5 py-4">
        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5 flex-wrap">
            {sourceBadge(item.sourceType)}
            {item.proposal?.status === "needs_onwrd_input" && (
              <span className="inline-flex items-center gap-1 text-[10px] text-amber-400">
                <AlertCircle className="w-2.5 h-2.5" /> Needs Input
              </span>
            )}
          </div>
          <h2 className="text-sm font-medium text-foreground leading-snug mb-1 truncate">
            {item.title}
          </h2>
          <p className="text-xs text-muted-foreground">
            {item.agency} · {item.category}
            {item.deadline ? ` · Due ${format(new Date(item.deadline), "MMM d, yyyy")}` : ""}
            {item.valueAmount ? ` · ${item.valueAmount}` : ""}
          </p>
        </div>

        {/* Action */}
        <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
          <ActionCell item={item} onGenerate={onGenerate} generating={generating} />
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function ProposalsWorkspace() {
  const { toast } = useToast();
  const [items, setItems] = useState<WorkspaceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [generatingId, setGeneratingId] = useState<number | null>(null);

  const fetchWorkspace = useCallback(async () => {
    try {
      const r = await fetch(`${BASE}/api/proposals/workspace`);
      if (!r.ok) throw new Error("Failed to fetch workspace");
      const data = await r.json() as WorkspaceItem[];
      setItems(data);
    } catch (err) {
      console.error("Workspace fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchWorkspace();
  }, [fetchWorkspace]);

  // Poll while any item is actively generating
  useEffect(() => {
    const hasActive = items.some(isActiveGeneration);
    if (!hasActive) return;
    const interval = setInterval(() => { void fetchWorkspace(); }, 3000);
    return () => clearInterval(interval);
  }, [items, fetchWorkspace]);

  const handleGenerate = async (opportunityId: number) => {
    setGeneratingId(opportunityId);
    try {
      const r = await fetch(`${BASE}/api/opportunities/${opportunityId}/run-full-generation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const body = await r.json() as { proposalId?: number; generationStatus?: string; error?: string; code?: string };

      if (!r.ok) {
        if (body.code === "google_doc_canonical") {
          toast({ title: "Already in Google Docs", description: "This proposal is already a Google Doc.", variant: "destructive" });
          return;
        }
        toast({ title: "Failed to start generation", description: body.error ?? "Unknown error", variant: "destructive" });
        return;
      }

      toast({ title: "Generating proposal…", description: "We'll update this card as each phase completes." });
      // Refresh immediately then polling takes over
      await fetchWorkspace();
    } catch (err) {
      toast({ title: "Error", description: (err as Error).message, variant: "destructive" });
    } finally {
      setGeneratingId(null);
    }
  };

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-white mb-1 tracking-tight">Proposals</h1>
        <p className="text-muted-foreground text-sm">Generate, review, and share proposals for your opportunities.</p>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full rounded-lg" />)}
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-16 px-4 border border-dashed rounded-lg bg-card/50">
          <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
            <FileText className="w-6 h-6 text-primary" />
          </div>
          <h3 className="text-lg font-medium text-foreground mb-2">No proposals yet</h3>
          <p className="text-muted-foreground mb-6 max-w-sm mx-auto">
            Upload or paste an RFP to get started, or select an opportunity from Discover.
          </p>
          <div className="flex items-center justify-center gap-3">
            <Button variant="outline" size="sm" onClick={() => window.location.href = `${BASE}/new?mode=import`}>
              <Upload className="w-3.5 h-3.5 mr-1.5" /> Upload RFP
            </Button>
            <Button variant="outline" size="sm" onClick={() => window.location.href = `${BASE}/new?mode=paste`}>
              <FileText className="w-3.5 h-3.5 mr-1.5" /> Paste RFP Text
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <WorkspaceCard
              key={item.id}
              item={item}
              onGenerate={handleGenerate}
              generatingId={generatingId}
            />
          ))}
        </div>
      )}
    </div>
  );
}
