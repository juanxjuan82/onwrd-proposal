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
  CheckCircle2,
  XCircle,
  PlayCircle,
  Zap,
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
  bid_scoring:             "Scoring bid fit",
  strategy_generating:     "Generating strategy",
  analysing:               "Analysing",
};

const STATUS_LABELS: Record<string, string> = {
  opportunity_found:        "Found",
  requirements_extracting:  "Extracting Requirements…",
  bid_scoring:              "Scoring Bid…",
  strategy_generating:      "Generating Strategy…",
  requirements_extracted:   "Requirements Extracted",
  screened:                 "Screened",
  no_bid:                   "No Bid",
  analysis_failed:          "Analysis Failed",
  analysis_cancelled:       "Analysis Cancelled",
  proposal_drafting:        "Drafting Proposal",
  needs_onwrd_input:        "Needs Input",
  ready_for_review:         "Ready for Review",
  bid_started:              "Bid Started",
};

const MAX_POLL_MS = 5 * 60 * 1_000;

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// New columns that may not yet be in the generated client types
type TenderExt = {
  analysisRunId?:   string | null;
  cancelledAt?:     string | null;
  completedSteps?:  string | null;
  aiInputTokens?:   number | null;
  aiOutputTokens?:  number | null;
  failedStep?:      string | null;
  failedErrorCode?: string | null;
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function TenderDetail() {
  const { id } = useParams<{ id: string }>();
  const tenderId = Number(id);
  const [, setLocation] = useLocation();
  const { data: tender, isLoading } = useGetTender(tenderId);
  const generate = useGenerateProposalFromTender();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const tenderExt = tender as (typeof tender & TenderExt) | undefined;

  const isAnalysing = ANALYSIS_IN_PROGRESS.has(tender?.status ?? "");
  const pollStartRef = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [pollTimedOut, setPollTimedOut] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [cancelling, setCancelling]  = useState(false);
  const [resuming, setResuming]      = useState(false);

  // Parse completed steps from DB JSON string
  const completedSteps: string[] = (() => {
    try { return JSON.parse(tenderExt?.completedSteps ?? "[]") as string[]; }
    catch { return []; }
  })();

  // Track when polling starts / stops
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

  // ── Actions ───────────────────────────────────────────────────────────────

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
      const res = await fetch(`${BASE}/api/opportunities/${tenderId}/analyze`, { method: "POST" });
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

  const handleCancel = async () => {
    const runId = tenderExt?.analysisRunId;
    if (!runId) {
      toast({ title: "Cannot cancel", description: "No active analysis run ID found.", variant: "destructive" });
      return;
    }
    setCancelling(true);
    try {
      const res = await fetch(`${BASE}/api/opportunities/${tenderId}/cancel-analysis`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ analysisRunId: runId }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        status?: string;
        alreadyCompleted?: boolean;
        error?: string;
        message?: string;
      };

      if (!res.ok) {
        toast({ title: "Cancel failed", description: body.error ?? "Unknown error", variant: "destructive" });
        return;
      }
      if (body.alreadyCompleted) {
        toast({ title: "Already finished", description: `The analysis completed before the cancel arrived (${body.status ?? ""}).` });
      } else {
        toast({ title: "Analysis cancelled", description: "The AI run has been stopped." });
      }
      void queryClient.invalidateQueries({ queryKey: getGetTenderQueryKey(tenderId) });
    } finally {
      setCancelling(false);
    }
  };

  const handleResume = async () => {
    setResuming(true);
    try {
      const res = await fetch(`${BASE}/api/opportunities/${tenderId}/resume-analysis`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { message?: string; fromStep?: string; error?: string };
      if (!res.ok) {
        toast({ title: "Cannot resume", description: body.error ?? "Unknown error", variant: "destructive" });
        return;
      }
      toast({
        title: "Resuming analysis",
        description: body.fromStep ? `Continuing from: ${STEP_LABELS[body.fromStep] ?? body.fromStep}` : body.message ?? "",
      });
      pollStartRef.current = Date.now();
      setPollTimedOut(false);
      void queryClient.invalidateQueries({ queryKey: getGetTenderQueryKey(tenderId) });
    } finally {
      setResuming(false);
    }
  };

  // ── Loading / not found ───────────────────────────────────────────────────

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
  const stepLabel   = STEP_LABELS[tender.status];

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

      {/* ── Analysis in-progress banner ──────────────────────────────────── */}
      {isAnalysing && !pollTimedOut && (
        <div className="mb-6 p-4 border border-primary/30 rounded-lg bg-primary/5">
          <div className="flex items-center gap-3">
            <Loader2 className="w-5 h-5 animate-spin text-primary shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">{stepLabel ?? "Analysing…"}</p>
              <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                <Clock className="w-3 h-3" />
                {elapsed > 0 ? `${elapsed}s elapsed` : "Starting…"} — auto-refreshing every 3 s
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleCancel()}
              disabled={cancelling || !tenderExt?.analysisRunId}
              className="shrink-0"
              data-testid="button-cancel-analysis"
            >
              {cancelling
                ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Cancelling…</>
                : <><XCircle className="w-3 h-3 mr-1" /> Cancel</>
              }
            </Button>
          </div>

          {/* Completed steps progress */}
          {completedSteps.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {completedSteps.map((step) => (
                <span key={step} className="inline-flex items-center gap-1 text-xs text-muted-foreground bg-muted/50 px-2 py-0.5 rounded-full">
                  <CheckCircle2 className="w-3 h-3 text-green-500" />
                  {STEP_LABELS[step] ?? step}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Poll timed-out warning ───────────────────────────────────────── */}
      {isAnalysing && pollTimedOut && (
        <div className="mb-6 flex items-start gap-3 p-4 border border-yellow-500/30 rounded-lg bg-yellow-500/5">
          <AlertTriangle className="w-5 h-5 text-yellow-500 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground">Analysis is taking longer than expected</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Polling stopped after 5 minutes. The job may still be running — refresh to check, or retry.
            </p>
          </div>
          <Button size="sm" variant="outline" onClick={() => void queryClient.invalidateQueries({ queryKey: getGetTenderQueryKey(tenderId) })}>
            <RefreshCw className="w-3 h-3 mr-1" /> Refresh
          </Button>
        </div>
      )}

      {/* ── Analysis failed banner ───────────────────────────────────────── */}
      {tender.status === "analysis_failed" && (
        <div className="mb-6 p-4 border border-destructive/30 rounded-lg bg-destructive/5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">Analysis failed</p>
              {tenderExt?.failedStep && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  Failed at: <span className="font-medium">{STEP_LABELS[tenderExt.failedStep] ?? tenderExt.failedStep}</span>
                  {tenderExt.failedErrorCode && <> · Code: <span className="font-medium">{tenderExt.failedErrorCode}</span></>}
                </p>
              )}
              {completedSteps.length > 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                  Completed: {completedSteps.map((s) => STEP_LABELS[s] ?? s).join(" → ")}
                </p>
              )}
            </div>
            <div className="flex gap-2 shrink-0">
              {completedSteps.length > 0 && (
                <Button size="sm" variant="outline" onClick={() => void handleResume()} disabled={resuming}>
                  {resuming
                    ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Resuming…</>
                    : <><PlayCircle className="w-3 h-3 mr-1" /> Resume</>
                  }
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => void handleReanalyze()} disabled={reanalyzing}>
                {reanalyzing
                  ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Starting…</>
                  : <><RefreshCw className="w-3 h-3 mr-1" /> Retry</>
                }
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Analysis cancelled banner ────────────────────────────────────── */}
      {tender.status === "analysis_cancelled" && (
        <div className="mb-6 p-4 border border-yellow-500/30 rounded-lg bg-yellow-500/5">
          <div className="flex items-start gap-3">
            <XCircle className="w-5 h-5 text-yellow-500 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground">Analysis cancelled</p>
              {tenderExt?.failedStep && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  Stopped at: <span className="font-medium">{STEP_LABELS[tenderExt.failedStep] ?? tenderExt.failedStep}</span>
                </p>
              )}
              {completedSteps.length > 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                  Completed: {completedSteps.map((s) => STEP_LABELS[s] ?? s).join(" → ")}
                </p>
              )}
            </div>
            <div className="flex gap-2 shrink-0">
              {completedSteps.length > 0 && (
                <Button size="sm" variant="outline" onClick={() => void handleResume()} disabled={resuming}>
                  {resuming
                    ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Resuming…</>
                    : <><PlayCircle className="w-3 h-3 mr-1" /> Resume</>
                  }
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => void handleReanalyze()} disabled={reanalyzing}>
                {reanalyzing
                  ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Starting…</>
                  : <><RefreshCw className="w-3 h-3 mr-1" /> Re-analyse from scratch</>
                }
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Metadata grid ────────────────────────────────────────────────── */}
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
        {/* Token usage — shown after any AI step completes */}
        {((tenderExt?.aiInputTokens ?? 0) > 0 || (tenderExt?.aiOutputTokens ?? 0) > 0) && (
          <div>
            <p className="text-xs uppercase text-muted-foreground mb-1 flex items-center gap-1">
              <Zap className="w-3 h-3" /> Token usage
            </p>
            <p className="text-sm font-medium text-muted-foreground">
              {(tenderExt?.aiInputTokens ?? 0).toLocaleString()} in · {(tenderExt?.aiOutputTokens ?? 0).toLocaleString()} out
            </p>
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

      {/* ── Action buttons ────────────────────────────────────────────────── */}
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
            {generate.isPending
              ? <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Generating…</>
              : <><Sparkles className="w-4 h-4 mr-1" /> Generate Proposal from Tender</>
            }
          </Button>
        )}

        {!isAnalysing &&
          tender.status !== "analysis_failed" &&
          tender.status !== "analysis_cancelled" && (
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
