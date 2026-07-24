import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Target, CheckCircle2, XCircle, Clock, AlertCircle,
  Globe, Upload, AlertTriangle, RefreshCw, ExternalLink, Loader2,
  ChevronRight, Pencil, Zap, FileText,
} from "lucide-react";
import { format } from "date-fns";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// ── Types ───────────────────────────────────────────────────────────────────
interface BidScore {
  id: number;
  fitScore: number;
  fitLevel: string;
  reasoning: string;
  flags: string;
  completenessScore: number;
  missingFields: string;
}

interface Opportunity {
  id: number;
  title: string;
  agency: string;
  category: string;
  status: string;
  recommendationScore: number;
  deadline?: string | null;
  valueAmount?: string | null;
  sourceUrl?: string | null;
  sourceType?: string | null;
  contactInfo?: string | null;
  description: string;
  rawText?: string | null;
  googleDocId?: string | null;
  googleDocUrl?: string | null;
  createdAt: string;
  updatedAt: string;
  bidScore: BidScore | null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function fitColor(level: string) {
  if (level === "strong") return "text-emerald-400";
  if (level === "moderate") return "text-yellow-400";
  if (level === "weak") return "text-orange-400";
  return "text-red-400";
}

function completenessColor(score: number) {
  if (score >= 70) return "text-emerald-400";
  if (score >= 40) return "text-amber-400";
  return "text-red-400";
}

function fitBg(level: string) {
  if (level === "strong") return "border-emerald-900/50 bg-emerald-950/20";
  if (level === "moderate") return "border-yellow-900/50 bg-yellow-950/20";
  if (level === "weak") return "border-orange-900/50 bg-orange-950/20";
  return "border-red-900/50 bg-red-950/20";
}

function statusIcon(status: string) {
  if (status === "no_bid") return <XCircle className="w-3.5 h-3.5 text-red-400" />;
  if (status === "bid_started") return <Zap className="w-3.5 h-3.5 text-emerald-400" />;
  if (status === "exported_to_drive" || status === "approved_for_export")
    return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />;
  if (status === "proposal_drafting" || status === "needs_onwrd_input")
    return <Clock className="w-3.5 h-3.5 text-yellow-400" />;
  if (status === "ready_for_review")
    return <AlertCircle className="w-3.5 h-3.5 text-blue-400" />;
  return <Target className="w-3.5 h-3.5 text-muted-foreground" />;
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    opportunity_found:       "Found",
    pending_review:          "Pending Review",
    analysing:               "Analysing…",
    requirements_extracting: "Extracting…",
    bid_scoring:             "Scoring…",
    strategy_generating:     "Generating Strategy…",
    requirements_extracted:  "Requirements Extracted",
    screened:                "Screened",
    analysis_failed:         "Analysis Failed",
    analysis_cancelled:      "Cancelled",
    no_bid:                  "No Bid",
    bid_started:             "Bid Started",
    proposal_drafting:       "Drafting",
    needs_onwrd_input:       "Needs Input",
    ready_for_review:        "Ready for Review",
    approved_for_export:     "Approved",
    exported_to_drive:       "Exported",
  };
  return labels[status] ?? status;
}

interface SourceMeta { label: string; icon: React.ReactNode; cls: string; title: string }

function resolveSource(opp: Opportunity): SourceMeta {
  const LEGACY = { label: "Legacy", icon: <Clock className="w-2.5 h-2.5" />, cls: "border-zinc-700/50 bg-zinc-900/30 text-zinc-500", title: "Pre-sourceType record" };
  if (!opp.sourceType) return LEGACY;
  switch (opp.sourceType) {
    case "crawler":
      return { label: "Scraped",    icon: <Globe className="w-2.5 h-2.5" />,       cls: "border-blue-900/50 bg-blue-950/30 text-blue-400",       title: opp.sourceUrl ?? "Web crawler" };
    case "url":
      return { label: "URL Import", icon: <ExternalLink className="w-2.5 h-2.5" />, cls: "border-sky-900/50 bg-sky-950/30 text-sky-400",          title: opp.sourceUrl ?? "URL import" };
    case "rfp_upload":
      return { label: "Uploaded",   icon: <Upload className="w-2.5 h-2.5" />,       cls: "border-violet-900/50 bg-violet-950/30 text-violet-400", title: "RFP file upload" };
    case "pasted_text":
      return { label: "Pasted",     icon: <FileText className="w-2.5 h-2.5" />,     cls: "border-violet-900/50 bg-violet-950/30 text-violet-400", title: "Pasted RFP text" };
    case "csv":
      return { label: "CSV",        icon: <FileText className="w-2.5 h-2.5" />,     cls: "border-violet-900/50 bg-violet-950/30 text-violet-400", title: "CSV import" };
    case "prospect_intake":
      return { label: "Prospect",   icon: <Zap className="w-2.5 h-2.5" />,          cls: "border-emerald-900/50 bg-emerald-950/30 text-emerald-400", title: "Prospect intake form" };
    default:
      return LEGACY;
  }
}

function SourceBadge({ opp }: { opp: Opportunity }) {
  const { label, icon, cls, title } = resolveSource(opp);
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}
    >
      {icon}
      {label}
    </span>
  );
}

// ── Hooks ───────────────────────────────────────────────────────────────────
function useOpportunities() {
  return useQuery<Opportunity[]>({
    queryKey: ["opportunities"],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/opportunities`);
      if (!r.ok) throw new Error("Failed to load opportunities");
      return r.json();
    },
    refetchInterval: 8000,
  });
}

function useUpdateOpportunity(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Partial<{
      title: string; agency: string; description: string; category: string;
      valueAmount: string; deadline: string; rawText: string; contactInfo: string; sourceUrl: string; status: string;
    }>) => {
      const r = await fetch(`${BASE}/api/opportunities/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error((e as { error?: string }).error ?? "Failed to update");
      }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["opportunities"] });
      qc.invalidateQueries({ queryKey: ["opportunity", id] });
    },
  });
}

function useRescoreOpportunity(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const r = await fetch(`${BASE}/api/opportunities/${id}/score`, { method: "POST" });
      if (!r.ok) throw new Error("Re-score failed");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["opportunities"] }),
  });
}

function useCreateOpportunity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      title: string; agency: string; description: string;
      category?: string; deadline?: string; valueAmount?: string; rawText?: string;
    }) => {
      const r = await fetch(`${BASE}/api/opportunities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error((e as { error?: string }).error ?? "Failed to create opportunity");
      }
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["opportunities"] }),
  });
}

function usePursue(id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<{ proposalId: number }> => {
      const r = await fetch(`${BASE}/api/opportunities/${id}/pursue`, { method: "POST" });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error((e as { error?: string }).error ?? "Failed to pursue opportunity");
      }
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["opportunities"] }),
  });
}

// ── Score display ────────────────────────────────────────────────────────────
function ScoreColumn({ opp }: { opp: Opportunity }) {
  const bs = opp.bidScore;
  if (!bs && opp.status === "analysing") {
    return (
      <div className="flex flex-col items-center gap-1 min-w-[100px]">
        <Loader2 className="w-5 h-5 text-muted-foreground animate-spin" />
        <span className="text-[10px] text-muted-foreground">Analysing…</span>
      </div>
    );
  }
  if (!bs) return (
    <div className="min-w-[100px] text-center">
      <span className="text-xs text-muted-foreground">Not scored</span>
    </div>
  );

  const missing: string[] = JSON.parse(bs.missingFields || "[]");

  return (
    <div className="flex flex-col gap-1.5 min-w-[120px] items-end">
      <div className="flex items-center gap-3">
        <div className="text-center">
          <div className={`text-xl font-bold leading-none ${fitColor(bs.fitLevel)}`}>{bs.fitScore}</div>
          <div className="text-[9px] text-muted-foreground uppercase tracking-wide mt-0.5">Fit</div>
        </div>
        <div className="text-center">
          <div className={`text-xl font-bold leading-none flex items-center gap-0.5 ${completenessColor(bs.completenessScore)}`}>
            {bs.completenessScore < 70 && <AlertTriangle className="w-3 h-3" />}
            {bs.completenessScore}
          </div>
          <div className="text-[9px] text-muted-foreground uppercase tracking-wide mt-0.5">Brief</div>
        </div>
      </div>
      {missing.length > 0 && (
        <div className="flex flex-wrap gap-1 justify-end max-w-[160px]">
          {missing.slice(0, 3).map((m, i) => (
            <span key={i} className="rounded-full bg-amber-900/40 text-amber-300 border border-amber-700/40 px-1.5 py-0.5 text-[9px]">
              {m}
            </span>
          ))}
          {missing.length > 3 && (
            <span className="rounded-full bg-muted text-muted-foreground px-1.5 py-0.5 text-[9px]">
              +{missing.length - 3}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ── Enrich Drawer ────────────────────────────────────────────────────────────
function EnrichDrawer({
  opp,
  open,
  onClose,
}: {
  opp: Opportunity;
  open: boolean;
  onClose: () => void;
}) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const update = useUpdateOpportunity(opp.id);
  const rescore = useRescoreOpportunity(opp.id);
  const pursue = usePursue(opp.id);

  const handleStartBid = async () => {
    try {
      const result = await pursue.mutateAsync();
      toast({
        title: "Bid workspace created",
        description: "Opening the proposal workspace…",
      });
      onClose();
      setLocation(`/proposals/${result.proposalId}`);
    } catch (err) {
      toast({ title: "Failed to pursue opportunity", description: (err as Error).message, variant: "destructive" });
    }
  };

  const [form, setForm] = useState({
    title: opp.title,
    agency: opp.agency,
    category: opp.category,
    description: opp.description,
    valueAmount: opp.valueAmount ?? "",
    deadline: opp.deadline ? opp.deadline.slice(0, 10) : "",
    contactInfo: opp.contactInfo ?? "",
    rawText: opp.rawText ?? "",
  });

  useEffect(() => {
    setForm({
      title: opp.title,
      agency: opp.agency,
      category: opp.category,
      description: opp.description,
      valueAmount: opp.valueAmount ?? "",
      deadline: opp.deadline ? opp.deadline.slice(0, 10) : "",
      contactInfo: opp.contactInfo ?? "",
      rawText: opp.rawText ?? "",
    });
  }, [opp.id]);

  const bs = opp.bidScore;
  const missing: string[] = bs ? JSON.parse(bs.missingFields || "[]") : [];

  const handleSave = async () => {
    try {
      await update.mutateAsync({
        title: form.title,
        agency: form.agency,
        category: form.category,
        description: form.description,
        valueAmount: form.valueAmount,
        deadline: form.deadline,
        contactInfo: form.contactInfo,
        rawText: form.rawText,
      });
      toast({ title: "Saved", description: "Opportunity updated successfully." });
    } catch (err) {
      toast({ title: "Save failed", description: (err as Error).message, variant: "destructive" });
    }
  };

  const handleRescore = async () => {
    try {
      await rescore.mutateAsync();
      toast({ title: "Re-scored", description: "Bid analysis updated." });
    } catch {
      toast({ title: "Re-score failed", variant: "destructive" });
    }
  };

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-xl flex flex-col gap-0 p-0 overflow-hidden">
        {/* Header */}
        <SheetHeader className="px-6 py-4 border-b bg-card shrink-0">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <SourceBadge opp={opp} />
                <span className={`inline-flex items-center gap-1 text-xs ${
                  opp.status === "no_bid" ? "text-red-400" : opp.status === "screened" ? "text-emerald-400" : "text-muted-foreground"
                }`}>
                  {statusIcon(opp.status)}
                  {statusLabel(opp.status)}
                </span>
              </div>
              <SheetTitle className="text-base font-semibold text-foreground leading-snug">
                {opp.title}
              </SheetTitle>
              <SheetDescription className="text-xs text-muted-foreground mt-0.5">
                {opp.agency} · {opp.category}
              </SheetDescription>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 text-xs gap-1.5"
              onClick={() => { onClose(); setLocation(`/opportunities/${opp.id}`); }}
            >
              <ExternalLink className="w-3 h-3" />
              Full Detail
            </Button>
          </div>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto">
          {/* Score summary */}
          {bs && (
            <div className={`mx-6 mt-4 rounded-lg border p-4 ${fitBg(bs.fitLevel)}`}>
              <div className="flex items-center gap-6 mb-2">
                <div className="text-center">
                  <div className={`text-3xl font-bold ${fitColor(bs.fitLevel)}`}>{bs.fitScore}</div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Fit</div>
                </div>
                <div className="text-center">
                  <div className={`text-3xl font-bold flex items-center gap-1 ${completenessColor(bs.completenessScore)}`}>
                    {bs.completenessScore < 70 && <AlertTriangle className="w-4 h-4" />}
                    {bs.completenessScore}
                  </div>
                  <div className="text-[10px] text-muted-foreground uppercase tracking-wide">Brief</div>
                </div>
                <p className="flex-1 text-xs text-muted-foreground leading-relaxed">{bs.reasoning}</p>
              </div>
              {missing.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-2 border-t border-current/20">
                  {missing.map((m, i) => (
                    <span key={i} className="rounded-full bg-amber-900/40 text-amber-300 border border-amber-700/40 px-2 py-0.5 text-xs">
                      {m}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Enrich / edit section */}
          <div className="px-6 py-4 space-y-4">
            <div className="flex items-center gap-2">
              <Pencil className="w-3.5 h-3.5 text-muted-foreground" />
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Enrich this Brief</h3>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Title</Label>
                <Input className="text-sm h-8" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Issuing Agency</Label>
                <Input className="text-sm h-8" value={form.agency} onChange={(e) => setForm({ ...form, agency: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Category</Label>
                <Input className="text-sm h-8" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Estimated Value</Label>
                <Input className="text-sm h-8" placeholder="BSD $150,000" value={form.valueAmount} onChange={(e) => setForm({ ...form, valueAmount: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Submission Deadline</Label>
                <Input type="date" className="text-sm h-8" value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Contact Info</Label>
                <Input className="text-sm h-8" placeholder="Name, email, or phone" value={form.contactInfo} onChange={(e) => setForm({ ...form, contactInfo: e.target.value })} />
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">Description</Label>
              <Textarea rows={3} className="text-sm resize-none" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <Label className="text-xs">Full RFP / Raw Document Text</Label>
                <span className="text-[10px] text-muted-foreground">{form.rawText.length} chars</span>
              </div>
              <Textarea
                rows={8}
                className="text-xs font-mono resize-y"
                placeholder="Paste or type additional context — budget details, notes from a client call, or the full RFP text…"
                value={form.rawText}
                onChange={(e) => setForm({ ...form, rawText: e.target.value })}
              />
            </div>
          </div>
        </div>

        {/* Footer actions */}
        <div className="px-6 py-4 border-t bg-card shrink-0 space-y-3">
          {/* Pursue CTA */}
          <Button
            className="w-full bg-emerald-600 hover:bg-emerald-500 text-white gap-2 text-sm"
            onClick={handleStartBid}
            disabled={pursue.isPending}
          >
            {pursue.isPending
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Opening workspace…</>
              : <><Zap className="w-4 h-4" /> Pursue this Opportunity</>
            }
          </Button>

          {/* Secondary actions */}
          <div className="flex items-center justify-between gap-3">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs"
              onClick={handleRescore}
              disabled={rescore.isPending || update.isPending || pursue.isPending}
            >
              {rescore.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              Re-score
            </Button>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" className="text-xs" onClick={onClose}>Cancel</Button>
              <Button size="sm" className="text-xs gap-1.5" onClick={handleSave} disabled={update.isPending || rescore.isPending || pursue.isPending}>
                {update.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
                Save Changes
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Opportunity Card ─────────────────────────────────────────────────────────
function OpportunityCard({ opp, onReview }: { opp: Opportunity; onReview: () => void }) {
  return (
    <div className="group bg-card border rounded-lg hover:border-primary/40 transition-colors">
      <button className="w-full text-left px-5 py-4" onClick={onReview}>
        <div className="flex items-start gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
              <SourceBadge opp={opp} />
              <span className={`inline-flex items-center gap-1 text-xs ${
                opp.status === "no_bid" ? "text-red-400"
                  : opp.status === "bid_started" ? "text-emerald-400"
                  : opp.status === "screened" || opp.status === "ready_for_review" ? "text-emerald-400"
                  : opp.status === "analysing" ? "text-blue-400"
                  : "text-muted-foreground"
              }`}>
                {statusIcon(opp.status)}
                {statusLabel(opp.status)}
              </span>
              {opp.status === "analysing" && (
                <Loader2 className="w-3 h-3 text-blue-400 animate-spin" />
              )}
              {opp.googleDocUrl && (
                <a
                  href={opp.googleDocUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="inline-flex items-center gap-1 text-[10px] text-emerald-400 border border-emerald-800/50 bg-emerald-950/30 rounded-full px-2 py-0.5 hover:bg-emerald-900/40 transition-colors"
                >
                  <FileText className="w-2.5 h-2.5" />
                  View Bid Doc
                </a>
              )}
            </div>
            <h2 className="text-sm font-medium text-foreground group-hover:text-primary transition-colors leading-snug mb-1">
              {opp.title}
            </h2>
            <p className="text-xs text-muted-foreground">
              {opp.agency} · {opp.category}
              {opp.deadline ? ` · Due ${format(new Date(opp.deadline), "MMM d, yyyy")}` : ""}
              {opp.valueAmount ? ` · ${opp.valueAmount}` : ""}
            </p>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <ScoreColumn opp={opp} />
            <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
          </div>
        </div>
      </button>
    </div>
  );
}

// ── Create dialog (kept for quick add) ──────────────────────────────────────
function CreateDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (id: number) => void;
}) {
  const { toast } = useToast();
  const createOpp = useCreateOpportunity();
  const [form, setForm] = useState({
    title: "", agency: "", description: "", category: "Marketing",
    deadline: "", valueAmount: "", rawText: "",
  });

  const handleCreate = async () => {
    if (!form.title || !form.agency || !form.description) {
      toast({ title: "Missing fields", description: "Title, agency, and description are required.", variant: "destructive" });
      return;
    }
    try {
      const created = await createOpp.mutateAsync({
        title: form.title, agency: form.agency, description: form.description,
        category: form.category || undefined, deadline: form.deadline || undefined,
        valueAmount: form.valueAmount || undefined, rawText: form.rawText || undefined,
      });
      toast({ title: "Opportunity created", description: "AI analysis is running in the background." });
      onClose();
      setForm({ title: "", agency: "", description: "", category: "Marketing", deadline: "", valueAmount: "", rawText: "" });
      onCreate(created.id);
    } catch (err) {
      toast({ title: "Create failed", description: (err as Error).message, variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Add Opportunity</DialogTitle></DialogHeader>
        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>Title *</Label>
              <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="RFP: Digital Marketing Services" />
            </div>
            <div className="space-y-1">
              <Label>Issuing Agency / Client *</Label>
              <Input value={form.agency} onChange={(e) => setForm({ ...form, agency: e.target.value })} placeholder="Ministry of Tourism" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>Category</Label>
              <Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="Marketing" />
            </div>
            <div className="space-y-1">
              <Label>Estimated Value</Label>
              <Input value={form.valueAmount} onChange={(e) => setForm({ ...form, valueAmount: e.target.value })} placeholder="BSD $150,000" />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Submission Deadline</Label>
            <Input type="date" value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label>Brief Description *</Label>
            <Textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Short summary of the opportunity…" />
          </div>
          <div className="space-y-1">
            <Label>Full RFP Text (optional)</Label>
            <Textarea rows={4} value={form.rawText} onChange={(e) => setForm({ ...form, rawText: e.target.value })} placeholder="Paste the full tender document text for richer AI analysis…" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={handleCreate} disabled={createOpp.isPending}>
            {createOpp.isPending ? "Creating…" : "Create & Analyse"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────
type FilterTab = "new" | "reviewing" | "in_progress" | "no_bid" | "all";

const FILTER_TABS: { key: FilterTab; label: string; test: (o: Opportunity) => boolean }[] = [
  {
    key: "new",
    label: "New",
    test: (o) => o.status === "opportunity_found" || o.status === "pending_review",
  },
  {
    key: "reviewing",
    label: "Reviewing",
    test: (o) =>
      ["analysing", "requirements_extracting", "bid_scoring", "strategy_generating",
        "requirements_extracted", "screened", "analysis_failed", "analysis_cancelled"].includes(o.status),
  },
  {
    key: "in_progress",
    label: "In Progress",
    test: (o) =>
      ["bid_started", "proposal_drafting", "needs_onwrd_input",
        "ready_for_review", "approved_for_export", "exported_to_drive"].includes(o.status),
  },
  { key: "no_bid", label: "No Bid", test: (o) => o.status === "no_bid" },
  { key: "all",    label: "All",    test: () => true },
];

export default function Opportunities() {
  const { data: opportunities, isLoading } = useOpportunities();
  const [filterTab, setFilterTab] = useState<FilterTab>("all");
  const [selected, setSelected] = useState<Opportunity | null>(null);

  const all = opportunities ?? [];

  const tabCounts = Object.fromEntries(
    FILTER_TABS.map((t) => [t.key, all.filter(t.test).length]),
  ) as Record<FilterTab, number>;

  const active = all.filter(FILTER_TABS.find((t) => t.key === filterTab)!.test);

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-white mb-1 tracking-tight">Opportunities</h1>
        <p className="text-muted-foreground text-sm">Score, enrich, and decide — then pursue or pass.</p>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 mb-5 border-b pb-0">
        {FILTER_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setFilterTab(t.key)}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              filterTab === t.key
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
            {tabCounts[t.key] > 0 && (
              <span className={`ml-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                filterTab === t.key
                  ? "bg-primary/20 text-primary"
                  : "bg-muted text-muted-foreground"
              }`}>
                {tabCounts[t.key]}
              </span>
            )}
          </button>
        ))}
        <span className="ml-auto self-center text-xs text-muted-foreground pr-1">
          {active.length} / {all.length}
        </span>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-20 w-full rounded-lg" />)}
        </div>
      ) : !active.length ? (
        <div className="text-center py-16 px-4 border border-dashed rounded-lg bg-card/50">
          <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
            <Target className="w-6 h-6 text-primary" />
          </div>
          <h3 className="text-lg font-medium text-foreground mb-2">
            {all.length === 0 ? "No opportunities yet" : `No ${FILTER_TABS.find((t) => t.key === filterTab)?.label.toLowerCase()} opportunities`}
          </h3>
          <p className="text-muted-foreground mb-6 max-w-sm mx-auto">
            {all.length === 0
              ? "Import an RFP or connect a tender source to begin scoring."
              : "Switch to All to see everything, or use the + New menu to add one."}
          </p>
          {all.length === 0 && (
            <Button asChild variant="outline" size="sm">
              <a href="/new?mode=import">Import RFP</a>
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {active.map((opp) => (
            <OpportunityCard
              key={opp.id}
              opp={opp}
              onReview={() => setSelected(opp)}
            />
          ))}
        </div>
      )}

      {selected && (
        <EnrichDrawer
          key={selected.id}
          opp={selected}
          open={Boolean(selected)}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
