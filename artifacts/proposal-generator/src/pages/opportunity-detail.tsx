import { useState } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowLeft,
  Target,
  ListChecks,
  Sparkles,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Clock,
  ExternalLink,
  ChevronRight,
  Loader2,
  Lightbulb,
  ShieldAlert,
  MessageSquare,
  BookOpen,
  RefreshCw,
} from "lucide-react";
import { format } from "date-fns";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const ANALYZING_STATUSES = ["opportunity_found", "analysing", "requirements_extracted"];

interface Requirement {
  id: number;
  requirementText: string;
  category: string;
  isMandatory: boolean;
  isAnswered: boolean;
  orderIndex: number;
}

interface BidScore {
  id: number;
  fitScore: number;
  fitLevel: string;
  reasoning: string;
  flags: string;
}

interface ProposalStrategy {
  id: number;
  positioning: string;
  winThemes: string;
  recommendedCaseStudies: string;
  risks: string;
  messagingGuidance: string;
  createdAt: string;
}

interface OpportunityDetail {
  id: number;
  title: string;
  agency: string;
  description: string;
  category: string;
  status: string;
  recommendationScore: number;
  deadline?: string | null;
  valueAmount?: string | null;
  sourceUrl?: string | null;
  contactInfo?: string | null;
  rawText?: string | null;
  requirementsExtractedAt?: string | null;
  proposalId?: number | null;
  createdAt: string;
  requirements: Requirement[];
  bidScore: BidScore | null;
  strategy: ProposalStrategy | null;
}

function useOpportunityDetail(id: number) {
  return useQuery<OpportunityDetail>({
    queryKey: ["opportunities", id],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/opportunities/${id}`);
      if (!r.ok) throw new Error("Failed to load opportunity");
      return r.json();
    },
    enabled: !isNaN(id),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && ANALYZING_STATUSES.includes(status) ? 3000 : false;
    },
  });
}

function fitColor(level: string) {
  if (level === "strong") return "text-green-400";
  if (level === "moderate") return "text-yellow-400";
  if (level === "weak") return "text-orange-400";
  return "text-red-400";
}

function fitBg(level: string) {
  if (level === "strong") return "bg-green-900/20 border-green-900";
  if (level === "moderate") return "bg-yellow-900/20 border-yellow-900";
  if (level === "weak") return "bg-orange-900/20 border-orange-900";
  return "bg-red-900/20 border-red-900";
}

const categoryColors: Record<string, string> = {
  technical: "bg-blue-900/20 text-blue-300 border-blue-900",
  budget: "bg-green-900/20 text-green-300 border-green-900",
  timeline: "bg-yellow-900/20 text-yellow-300 border-yellow-900",
  personnel: "bg-purple-900/20 text-purple-300 border-purple-900",
  certifications: "bg-pink-900/20 text-pink-300 border-pink-900",
  format: "bg-gray-900/20 text-gray-300 border-gray-700",
  deliverable: "bg-indigo-900/20 text-indigo-300 border-indigo-900",
  compliance: "bg-red-900/20 text-red-300 border-red-900",
  general: "bg-muted text-muted-foreground border-border",
};

function StrategyBrief({ strategy }: { strategy: ProposalStrategy }) {
  const winThemes: string[] = JSON.parse(strategy.winThemes || "[]");
  const caseStudies: string[] = JSON.parse(strategy.recommendedCaseStudies || "[]");
  const risks: string[] = JSON.parse(strategy.risks || "[]");

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-primary/20">
        <Lightbulb className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold text-primary">Proposal Strategy Brief</span>
        <span className="ml-auto text-xs text-muted-foreground">AI-generated · review before generating</span>
      </div>

      <div className="p-4 space-y-4">
        {strategy.positioning && (
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Positioning</p>
            <p className="text-sm text-foreground leading-relaxed">{strategy.positioning}</p>
          </div>
        )}

        {winThemes.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
              <Target className="w-3 h-3" /> Win Themes
            </p>
            <div className="flex flex-wrap gap-2">
              {winThemes.map((theme, i) => (
                <span key={i} className="inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                  {theme}
                </span>
              ))}
            </div>
          </div>
        )}

        {caseStudies.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
              <BookOpen className="w-3 h-3" /> Recommended Case Studies
            </p>
            <div className="space-y-1">
              {caseStudies.map((cs, i) => (
                <div key={i} className="flex items-center gap-2 text-sm text-foreground">
                  <CheckCircle2 className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
                  {cs}
                </div>
              ))}
            </div>
          </div>
        )}

        {risks.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
              <ShieldAlert className="w-3 h-3" /> Risks to Address
            </p>
            <div className="space-y-1">
              {risks.map((risk, i) => (
                <div key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 text-orange-400 flex-shrink-0" />
                  {risk}
                </div>
              ))}
            </div>
          </div>
        )}

        {strategy.messagingGuidance && (
          <div>
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
              <MessageSquare className="w-3 h-3" /> Messaging Guidance
            </p>
            <p className="text-sm text-foreground leading-relaxed italic">{strategy.messagingGuidance}</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function OpportunityDetail() {
  const [, params] = useRoute("/opportunities/:id");
  const id = Number(params?.id);
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: opp, isLoading } = useOpportunityDetail(id);

  const isAnalyzing = opp ? ANALYZING_STATUSES.includes(opp.status) : false;
  const analysisFailed = opp?.status === "analysis_failed";

  const extractRequirements = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${BASE}/api/opportunities/${id}/extract-requirements`, { method: "POST" });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error((e as { error?: string }).error ?? "Failed to extract requirements");
      }
      return r.json();
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["opportunities", id] });
      toast({ title: `${data.count} requirements extracted`, description: "Review them below, then score the opportunity." });
    },
    onError: (err) => {
      toast({ title: "Extraction failed", description: (err as Error).message, variant: "destructive" });
    },
  });

  const scoreBid = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${BASE}/api/opportunities/${id}/score`, { method: "POST" });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error((e as { error?: string }).error ?? "Failed to score");
      }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["opportunities", id] });
      toast({ title: "Scoring complete", description: "Bid/no-bid score calculated." });
    },
    onError: (err) => {
      toast({ title: "Scoring failed", description: (err as Error).message, variant: "destructive" });
    },
  });

  const generateStrategy = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${BASE}/api/opportunities/${id}/generate-strategy`, { method: "POST" });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error((e as { error?: string }).error ?? "Failed to generate strategy");
      }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["opportunities", id] });
      toast({ title: "Strategy brief generated" });
    },
    onError: (err) => {
      toast({ title: "Strategy failed", description: (err as Error).message, variant: "destructive" });
    },
  });

  const generateProposal = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${BASE}/api/opportunities/${id}/generate-proposal`, { method: "POST" });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error((e as { error?: string }).error ?? "Failed to generate proposal");
      }
      return r.json();
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["opportunities", id] });
      toast({
        title: "Proposal generation started",
        description: "15 sections are being written by AI. Open the proposal to track progress (~30–60 seconds).",
        duration: 8000,
      });
      setLocation(`/proposals/${data.proposal.id}`);
    },
    onError: (err) => {
      toast({ title: "Generation failed", description: (err as Error).message, variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="p-8 max-w-5xl mx-auto space-y-6">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-12 w-3/4" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-60 w-full" />
      </div>
    );
  }

  if (!opp) {
    return (
      <div className="p-8 max-w-5xl mx-auto text-center py-20">
        <h2 className="text-2xl font-semibold mb-4">Opportunity not found</h2>
        <Button onClick={() => setLocation("/opportunities")} variant="outline">
          Back to Opportunities
        </Button>
      </div>
    );
  }

  const flags: string[] = opp.bidScore ? JSON.parse(opp.bidScore.flags || "[]") : [];

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-8">
      {/* Back */}
      <button
        onClick={() => setLocation("/opportunities")}
        className="flex items-center gap-2 text-sm text-muted-foreground hover:text-white transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        All Opportunities
      </button>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold text-white tracking-tight">{opp.title}</h1>
          <p className="text-muted-foreground">
            {opp.agency} · {opp.category}
            {opp.deadline ? ` · Due ${format(new Date(opp.deadline), "MMM d, yyyy")}` : ""}
          </p>
        </div>
        {opp.proposalId ? (
          <Button onClick={() => setLocation(`/proposals/${opp.proposalId}`)}>
            <ExternalLink className="w-4 h-4 mr-2" />
            Open Proposal
            <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        ) : (
          <Button
            onClick={() => generateProposal.mutate()}
            disabled={generateProposal.isPending || isAnalyzing || !opp.bidScore || opp.bidScore.fitLevel === "no_bid"}
          >
            <Sparkles className="w-4 h-4 mr-2" />
            {generateProposal.isPending ? "Starting…" : "Generate Proposal"}
          </Button>
        )}
      </div>

      {/* Auto-analysis banner */}
      {isAnalyzing && (
        <div className="flex items-center gap-3 p-4 rounded-lg border border-primary/30 bg-primary/5">
          <Loader2 className="w-4 h-4 text-primary animate-spin flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-primary">AI is analysing this opportunity…</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Extracting requirements, scoring bid fit, and generating a strategy brief. This takes about 30–60 seconds.
            </p>
          </div>
        </div>
      )}

      {/* Analysis failed banner */}
      {analysisFailed && (
        <div className="flex items-start gap-3 p-4 rounded-lg border border-destructive/40 bg-destructive/5">
          <AlertCircle className="w-4 h-4 text-destructive mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-destructive">Auto-analysis failed</p>
            <p className="text-xs text-muted-foreground mt-0.5 mb-3">
              The AI couldn't complete the pipeline — likely a temporary quota issue. Run each step manually below.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => extractRequirements.mutate()} disabled={extractRequirements.isPending}>
                {extractRequirements.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-1" />}
                Extract Requirements
              </Button>
              <Button size="sm" variant="outline" onClick={() => scoreBid.mutate()} disabled={scoreBid.isPending}>
                {scoreBid.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Target className="w-3 h-3 mr-1" />}
                Score Bid
              </Button>
              <Button size="sm" variant="outline" onClick={() => generateStrategy.mutate()} disabled={generateStrategy.isPending}>
                {generateStrategy.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Lightbulb className="w-3 h-3 mr-1" />}
                Strategy Brief
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Meta */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        {opp.valueAmount && (
          <div className="p-4 rounded-lg border bg-card">
            <p className="text-xs text-muted-foreground mb-1">Estimated Value</p>
            <p className="text-sm font-medium">{opp.valueAmount}</p>
          </div>
        )}
        {opp.sourceUrl && (
          <div className="p-4 rounded-lg border bg-card">
            <p className="text-xs text-muted-foreground mb-1">Source</p>
            <a href={opp.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-primary hover:underline flex items-center gap-1">
              View document <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        )}
        <div className="p-4 rounded-lg border bg-card">
          <p className="text-xs text-muted-foreground mb-1">Added</p>
          <p className="text-sm font-medium">{format(new Date(opp.createdAt), "MMM d, yyyy")}</p>
        </div>
      </div>

      {/* Description */}
      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Description</h2>
        <div className="p-4 rounded-lg border bg-card text-sm text-foreground leading-relaxed whitespace-pre-wrap">
          {opp.description}
        </div>
      </div>

      {/* Bid Score */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
            <Target className="w-4 h-4" /> Bid/No-Bid Score
          </h2>
          {!opp.bidScore && !isAnalyzing && (
            <Button size="sm" variant="outline" onClick={() => scoreBid.mutate()} disabled={scoreBid.isPending}>
              {scoreBid.isPending ? (
                <><Clock className="w-4 h-4 mr-2 animate-spin" />Scoring…</>
              ) : (
                "Score this opportunity"
              )}
            </Button>
          )}
        </div>

        {opp.bidScore ? (
          <div className={`p-5 rounded-lg border ${fitBg(opp.bidScore.fitLevel)}`}>
            <div className="flex items-start gap-4">
              <div className="text-center">
                <div className={`text-4xl font-bold ${fitColor(opp.bidScore.fitLevel)}`}>
                  {opp.bidScore.fitScore}
                </div>
                <div className={`text-xs font-medium mt-1 ${fitColor(opp.bidScore.fitLevel)}`}>
                  {opp.bidScore.fitLevel === "no_bid" ? "No Bid" : opp.bidScore.fitLevel === "strong" ? "Strong Fit" : opp.bidScore.fitLevel === "moderate" ? "Moderate" : "Weak Fit"}
                </div>
              </div>
              <div className="flex-1 space-y-3">
                <p className="text-sm text-foreground leading-relaxed">{opp.bidScore.reasoning}</p>
                {flags.length > 0 && (
                  <div className="space-y-1.5">
                    {flags.map((flag, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                        <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                        {flag}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="mt-3 pt-3 border-t border-current/20 flex justify-end">
              <Button size="sm" variant="ghost" onClick={() => scoreBid.mutate()} disabled={scoreBid.isPending} className="text-xs">
                Re-score
              </Button>
            </div>
          </div>
        ) : !isAnalyzing ? (
          <div className="p-5 rounded-lg border border-dashed bg-card/50 text-center text-sm text-muted-foreground">
            Run a score to get AI-powered bid/no-bid recommendation.
          </div>
        ) : null}
      </div>

      {/* Strategy Brief */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
            <Lightbulb className="w-4 h-4" /> Strategy Brief
          </h2>
          {opp.strategy && (
            <Button size="sm" variant="ghost" onClick={() => generateStrategy.mutate()} disabled={generateStrategy.isPending} className="text-xs">
              <RefreshCw className={`w-3 h-3 mr-1.5 ${generateStrategy.isPending ? "animate-spin" : ""}`} />
              Regenerate
            </Button>
          )}
          {!opp.strategy && !isAnalyzing && opp.bidScore && (
            <Button size="sm" variant="outline" onClick={() => generateStrategy.mutate()} disabled={generateStrategy.isPending}>
              {generateStrategy.isPending ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Generating…</>
              ) : (
                "Generate Strategy"
              )}
            </Button>
          )}
        </div>

        {opp.strategy ? (
          <StrategyBrief strategy={opp.strategy} />
        ) : !isAnalyzing ? (
          <div className="p-5 rounded-lg border border-dashed bg-card/50 text-center text-sm text-muted-foreground">
            {opp.bidScore
              ? "Generate a strategy brief to define positioning and win themes before drafting."
              : "Score this opportunity first to unlock strategy generation."}
          </div>
        ) : null}
      </div>

      {/* Requirements */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
            <ListChecks className="w-4 h-4" />
            Requirements {opp.requirements.length > 0 && `(${opp.requirements.length})`}
          </h2>
          <Button size="sm" variant="outline" onClick={() => extractRequirements.mutate()} disabled={extractRequirements.isPending || isAnalyzing}>
            {extractRequirements.isPending ? (
              <><Clock className="w-4 h-4 mr-2 animate-spin" />Extracting…</>
            ) : opp.requirements.length > 0 ? (
              "Re-extract"
            ) : (
              "Extract Requirements"
            )}
          </Button>
        </div>

        {opp.requirements.length > 0 ? (
          <div className="space-y-2">
            {opp.requirements.map((req) => (
              <div key={req.id} className="flex items-start gap-3 p-3 rounded-lg border bg-card text-sm">
                {req.isMandatory ? (
                  <AlertCircle className="w-4 h-4 mt-0.5 text-orange-400 flex-shrink-0" />
                ) : (
                  <CheckCircle2 className="w-4 h-4 mt-0.5 text-muted-foreground flex-shrink-0" />
                )}
                <span className="flex-1 text-foreground leading-snug">{req.requirementText}</span>
                <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium shrink-0 ${categoryColors[req.category] ?? categoryColors.general}`}>
                  {req.category}
                </span>
                {req.isMandatory && (
                  <span className="text-xs text-orange-400 font-medium shrink-0">mandatory</span>
                )}
              </div>
            ))}
            {opp.requirementsExtractedAt && (
              <p className="text-xs text-muted-foreground pt-1">
                Extracted {format(new Date(opp.requirementsExtractedAt), "MMM d, yyyy 'at' h:mm a")}
              </p>
            )}
          </div>
        ) : (
          <div className="p-5 rounded-lg border border-dashed bg-card/50 text-center text-sm text-muted-foreground">
            {isAnalyzing ? "Extracting requirements…" : "Extract requirements to get a structured checklist from the RFP."}
          </div>
        )}
      </div>

      {/* Generate proposal CTA */}
      {!opp.proposalId && opp.bidScore && opp.bidScore.fitLevel !== "no_bid" && !isAnalyzing && (
        <div className="p-5 rounded-lg border bg-card flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Ready to generate a proposal?</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {opp.strategy
                ? "AI will use the strategy brief above to write all 15 sections with ONWRD's positioning and case studies."
                : "AI will write all 15 sections using ONWRD's positioning and case studies."}
            </p>
          </div>
          <Button onClick={() => generateProposal.mutate()} disabled={generateProposal.isPending}>
            <Sparkles className="w-4 h-4 mr-2" />
            {generateProposal.isPending ? "Launching…" : "Generate Proposal"}
          </Button>
        </div>
      )}

      {opp.proposalId && (
        <div className="p-5 rounded-lg border border-green-900 bg-green-900/10 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="w-5 h-5 text-green-400" />
            <div>
              <p className="text-sm font-medium">Proposal exists</p>
              <p className="text-xs text-muted-foreground mt-0.5">Proposal #{opp.proposalId} was generated from this opportunity.</p>
            </div>
          </div>
          <Button onClick={() => setLocation(`/proposals/${opp.proposalId}`)} variant="outline">
            Open Proposal <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        </div>
      )}

      {opp.bidScore?.fitLevel === "no_bid" && (
        <div className="p-5 rounded-lg border border-red-900 bg-red-900/10 flex items-center gap-3">
          <XCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
          <p className="text-sm text-muted-foreground">
            This opportunity is marked as <strong className="text-red-400">No Bid</strong>. If you'd like to proceed anyway, re-score or generate a proposal manually from the Proposals section.
          </p>
        </div>
      )}
    </div>
  );
}
