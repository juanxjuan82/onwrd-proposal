import { useEffect, useRef, useState } from "react";
import { useParams, useLocation, Link } from "wouter";
import { format } from "date-fns";
import {
  ArrowLeft,
  Sparkles,
  ExternalLink,
  Loader2,
  FileText,
  RefreshCw,
  AlertTriangle,
  Clock,
} from "lucide-react";
import {
  useGetTender,
  useGenerateProposalFromTender,
  getListTendersQueryKey,
  getGetTenderQueryKey,
  getListProposalsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";

// ── Analysis status helpers ───────────────────────────────────────────────────

const ANALYSIS_IN_PROGRESS = new Set([
  "analysing",
  "requirements_extracting",
  "bid_scoring",
  "strategy_generating",
]);

const STEP_LABELS: Record<string, string> = {
  requirements_extracting: "Extracting requirements",
  bid_scoring: "Scoring bid fit",
  strategy_generating: "Generating strategy",
  analysing: "Analysing",
};

const STATUS_LABELS: Record<string, string> = {
  opportunity_found: "Found",
  requirements_extracting: "Extracting Requirements…",
  bid_scoring: "Scoring Bid…",
  strategy_generating: "Generating Strategy…",
  requirements_extracted: "Requirements Extracted",
  screened: "Screened",
  no_bid: "No Bid",
  analysis_failed: "Analysis Failed",
  proposal_drafting: "Drafting Proposal",
  needs_onwrd_input: "Needs Input",
  ready_for_review: "Ready for Review",
  bid_started: "Bid Started",
};

const MAX_POLL_MS = 5 * 60 * 1_000; // stop polling after 5 minutes

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// ── Component ─────────────────────────────────────────────────────────────────

export default function TenderDetail() {
  const { id } = useParams<{ id: string }>();
  const tenderId = Number(id);
  const [, setLocation] = useLocation();
  const { data: tender, isLoading } = useGetTender(tenderId);
  const generate = useGenerateProposalFromTender();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const isAnalysing = ANALYSIS_IN_PROGRESS.has(tender?.status ?? "");
  const pollStartRef = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [pollTimedOut, setPollTimedOut] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);

  // Track when polling starts
  useEffect(() => {
    if (isAnalysing && pollStartRef.current === null) {
      pollStartRef.current = Date.now();
      setPollTimedOut(false);
    }
    if (!isAnalysing) {
      pollStartRef.current = null;
      setElapsed(0);
    }
  }, [isAnalysing]);

  // Poll every 3 s while analysis is active; stop after MAX_POLL_MS
  useEffect(() => {
    if (!isAnalysing || pollTimedOut) return;

    const interval = setInterval(() => {
      const age = Date.now() - (pollStartRef.current ?? Date.now());
      if (age >= MAX_POLL_MS) {
        setPollTimedOut(true);
        clearInterval(interval);
        return;
      }
      setElapsed(Math.floor(age / 1_000));
      void queryClient.invalidateQueries({ queryKey: getGetTenderQueryKey(tenderId) });
    }, 3_000);

    return () => clearInterval(interval);
  }, [isAnalysing, pollTimedOut, tenderId, queryClient]);

  const handleGenerate = async () => {
    try {
      const proposal = await generate.mutateAsync({ id: tenderId });
      queryClient.invalidateQueries({ queryKey: getListTendersQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetTenderQueryKey(tenderId) });
      queryClient.invalidateQueries({ queryKey: getListProposalsQueryKey() });
      toast({
        title: "Proposal draft started",
        description: "AI is generating the proposal in the background. Refresh in ~30 seconds.",
      });
      setLocation(`/proposals/${proposal.id}`);
    } catch (e) {
      toast({ title: "Generation failed", description: String(e), variant: "destructive" });
    }
  };

  const handleReanalyze = async () => {
    setReanalyzing(true);
    try {
      const res = await fetch(`${BASE}/api/opportunities/${tenderId}/analyze`, {
        method: "POST",
      });
      if (res.status === 409) {
        toast({ title: "Already running", description: "Analysis is already in progress." });
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast({ title: "Failed to start", description: body.error ?? "Unknown error", variant: "destructive" });
        return;
      }
      toast({ title: "Re-analysis started", description: "AI is re-extracting requirements and scoring the bid." });
      pollStartRef.current = Date.now();
      setPollTimedOut(false);
      void queryClient.invalidateQueries({ queryKey: getGetTenderQueryKey(tenderId) });
    } finally {
      setReanalyzing(false);
    }
  };

  if (isLoading) {
    return (
      <div className="p-8 max-w-4xl mx-auto">
        <Skeleton className="h-8 w-32 mb-6" />
        <Skeleton className="h-10 w-3/4 mb-4" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!tender) {
    return (
      <div className="p-8 max-w-4xl mx-auto">
        <Link href="/tenders" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mb-4">
          <ArrowLeft className="w-4 h-4" /> Back to Tenders
        </Link>
        <p>Tender not found.</p>
      </div>
    );
  }

  const statusLabel = STATUS_LABELS[tender.status] ?? tender.status;
  const stepLabel = STEP_LABELS[tender.status];

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <Link
        href="/tenders"
        className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mb-6"
        data-testid="link-back"
      >
        <ArrowLeft className="w-4 h-4" /> Back to Tenders
      </Link>

      <div className="mb-6">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <Badge variant="secondary">{tender.category}</Badge>
          {tender.recommendationScore > 0 && (
            <Badge variant="destructive">
              <Sparkles className="w-3 h-3 mr-1" /> Recommended
            </Badge>
          )}
          <Badge variant="outline">{statusLabel}</Badge>
        </div>
        <h1 className="text-3xl font-bold text-white mb-2 tracking-tight">{tender.title}</h1>
        <p className="text-lg text-foreground">{tender.agency}</p>
      </div>

      {/* ── Analysis-in-progress banner ─────────────────────────────────── */}
      {isAnalysing && !pollTimedOut && (
        <div className="mb-6 flex items-center gap-3 p-4 border border-primary/30 rounded-lg bg-primary/5">
          <Loader2 className="w-5 h-5 animate-spin text-primary shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground">
              {stepLabel ?? "Analysing…"}
            </p>
            <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
              <Clock className="w-3 h-3" />
              {elapsed > 0 ? `${elapsed}s elapsed` : "Starting…"} — auto-refreshing every 3 s
            </p>
          </div>
        </div>
      )}

      {/* ── Poll timed-out warning ──────────────────────────────────────── */}
      {isAnalysing && pollTimedOut && (
        <div className="mb-6 flex items-start gap-3 p-4 border border-yellow-500/30 rounded-lg bg-yellow-500/5">
          <AlertTriangle className="w-5 h-5 text-yellow-500 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground">Analysis is taking longer than expected</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Polling stopped after 5 minutes. The job may still be running — refresh the page to check, or retry.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => void queryClient.invalidateQueries({ queryKey: getGetTenderQueryKey(tenderId) })}>
            <RefreshCw className="w-3 h-3 mr-1" /> Refresh
          </Button>
        </div>
      )}

      {/* ── Analysis-failed banner ──────────────────────────────────────── */}
      {tender.status === "analysis_failed" && (
        <div className="mb-6 flex items-start gap-3 p-4 border border-destructive/30 rounded-lg bg-destructive/5">
          <AlertTriangle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground">Analysis failed</p>
            {(tender as unknown as { failedStep?: string; failedErrorCode?: string }).failedStep && (
              <p className="text-xs text-muted-foreground mt-0.5">
                Step: <span className="font-medium">{(tender as unknown as { failedStep?: string }).failedStep}</span>
                {(tender as unknown as { failedErrorCode?: string }).failedErrorCode &&
                  <> · Code: <span className="font-medium">{(tender as unknown as { failedErrorCode?: string }).failedErrorCode}</span></>
                }
              </p>
            )}
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void handleReanalyze()}
            disabled={reanalyzing}
          >
            {reanalyzing
              ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Starting…</>
              : <><RefreshCw className="w-3 h-3 mr-1" /> Retry</>
            }
          </Button>
        </div>
      )}

      <div className="grid sm:grid-cols-3 gap-4 mb-6 p-4 border rounded-lg bg-card">
        {tender.deadline && (
          <div>
            <p className="text-xs uppercase text-muted-foreground mb-1">Deadline</p>
            <p className="text-sm font-medium">{format(new Date(tender.deadline), "MMM d, yyyy")}</p>
          </div>
        )}
        {tender.valueAmount && (
          <div>
            <p className="text-xs uppercase text-muted-foreground mb-1">Estimated Value</p>
            <p className="text-sm font-medium">{tender.valueAmount}</p>
          </div>
        )}
        {tender.contactInfo && (
          <div>
            <p className="text-xs uppercase text-muted-foreground mb-1">Contact</p>
            <p className="text-sm font-medium">{tender.contactInfo}</p>
          </div>
        )}
      </div>

      <div className="mb-8">
        <h2 className="text-lg font-medium mb-2">Scope / Description</h2>
        <div className="p-4 border rounded-lg bg-card whitespace-pre-wrap text-sm text-foreground">
          {tender.description}
        </div>
        {tender.sourceUrl && (
          <a
            href={tender.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline mt-3"
          >
            View original source <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>

      <div className="flex flex-wrap gap-3">
        {tender.proposalId ? (
          <Button asChild variant="default" data-testid="button-view-proposal">
            <Link href={`/proposals/${tender.proposalId}`} className="flex items-center gap-2">
              <FileText className="w-4 h-4" /> View Generated Proposal
            </Link>
          </Button>
        ) : (
          <Button
            onClick={handleGenerate}
            disabled={generate.isPending || isAnalysing}
            data-testid="button-generate-proposal"
          >
            {generate.isPending ? (
              <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Generating…</>
            ) : (
              <><Sparkles className="w-4 h-4 mr-1" /> Generate Proposal from Tender</>
            )}
          </Button>
        )}

        {!isAnalysing && tender.status !== "analysis_failed" && (
          <Button
            variant="outline"
            onClick={() => void handleReanalyze()}
            disabled={reanalyzing}
            data-testid="button-reanalyze"
          >
            {reanalyzing
              ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Starting…</>
              : <><RefreshCw className="w-3 h-3 mr-1" /> Re-analyse</>
            }
          </Button>
        )}
      </div>
    </div>
  );
}
