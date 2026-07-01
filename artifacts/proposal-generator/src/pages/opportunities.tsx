import { useState } from "react";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus, Target, CheckCircle2, XCircle, Clock, AlertCircle } from "lucide-react";
import { format } from "date-fns";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

function fitBadge(level: string | undefined, score: number | undefined) {
  if (!level) return null;
  const cfg: Record<string, { label: string; className: string }> = {
    strong: { label: `Strong Fit (${score})`, className: "bg-green-900/30 text-green-400 border-green-900" },
    moderate: { label: `Moderate (${score})`, className: "bg-yellow-900/30 text-yellow-400 border-yellow-900" },
    weak: { label: `Weak (${score})`, className: "bg-orange-900/30 text-orange-400 border-orange-900" },
    no_bid: { label: "No Bid", className: "bg-red-900/30 text-red-400 border-red-900" },
  };
  const c = cfg[level] ?? { label: level, className: "bg-muted text-muted-foreground" };
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${c.className}`}>
      {c.label}
    </span>
  );
}

function statusIcon(status: string) {
  if (status === "no_bid") return <XCircle className="w-4 h-4 text-red-400" />;
  if (status === "exported_to_drive" || status === "approved_for_export") return <CheckCircle2 className="w-4 h-4 text-green-400" />;
  if (status === "proposal_drafting" || status === "needs_onwrd_input") return <Clock className="w-4 h-4 text-yellow-400" />;
  if (status === "ready_for_review") return <AlertCircle className="w-4 h-4 text-blue-400" />;
  return <Target className="w-4 h-4 text-muted-foreground" />;
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    opportunity_found: "Found",
    requirements_extracted: "Requirements Extracted",
    screened: "Screened",
    no_bid: "No Bid",
    proposal_drafting: "Drafting",
    needs_onwrd_input: "Needs Input",
    ready_for_review: "Ready for Review",
    approved_for_export: "Approved",
    exported_to_drive: "Exported",
  };
  return labels[status] ?? status;
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
  createdAt: string;
}

function useOpportunities() {
  return useQuery<Opportunity[]>({
    queryKey: ["opportunities"],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/opportunities`);
      if (!r.ok) throw new Error("Failed to load opportunities");
      return r.json();
    },
  });
}

function useCreateOpportunity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      title: string;
      agency: string;
      description: string;
      category?: string;
      deadline?: string;
      valueAmount?: string;
      rawText?: string;
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

export default function Opportunities() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { data: opportunities, isLoading } = useOpportunities();
  const createOpportunity = useCreateOpportunity();
  const [showCreate, setShowCreate] = useState(false);

  const [form, setForm] = useState({
    title: "",
    agency: "",
    description: "",
    category: "Marketing",
    deadline: "",
    valueAmount: "",
    rawText: "",
  });

  const handleCreate = async () => {
    if (!form.title || !form.agency || !form.description) {
      toast({ title: "Missing fields", description: "Title, agency, and description are required.", variant: "destructive" });
      return;
    }
    try {
      const created = await createOpportunity.mutateAsync({
        title: form.title,
        agency: form.agency,
        description: form.description,
        category: form.category || undefined,
        deadline: form.deadline || undefined,
        valueAmount: form.valueAmount || undefined,
        rawText: form.rawText || undefined,
      });
      toast({ title: "Opportunity created", description: "Use the detail page to extract requirements and score it." });
      setShowCreate(false);
      setForm({ title: "", agency: "", description: "", category: "Marketing", deadline: "", valueAmount: "", rawText: "" });
      setLocation(`/opportunities/${created.id}`);
    } catch (err) {
      toast({ title: "Create failed", description: (err as Error).message, variant: "destructive" });
    }
  };

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-8 gap-4">
        <div>
          <h1 className="text-4xl font-bold text-white mb-2 tracking-tight">Opportunities</h1>
          <p className="text-muted-foreground">RFP and tender pipeline — from discovery to proposal.</p>
        </div>
        <Button onClick={() => setShowCreate(true)}>
          <Plus className="w-4 h-4 mr-2" />
          Add Opportunity
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-24 w-full rounded-lg" />)}
        </div>
      ) : !opportunities?.length ? (
        <div className="text-center py-16 px-4 border border-dashed rounded-lg bg-card/50">
          <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
            <Target className="w-6 h-6 text-primary" />
          </div>
          <h3 className="text-lg font-medium text-foreground mb-2">No opportunities yet</h3>
          <p className="text-muted-foreground mb-6 max-w-sm mx-auto">
            Add an RFP or tender opportunity to start the bid/no-bid workflow.
          </p>
          <Button variant="outline" onClick={() => setShowCreate(true)}>Add Opportunity</Button>
        </div>
      ) : (
        <div className="grid gap-4">
          {opportunities.map((opp) => (
            <button
              key={opp.id}
              onClick={() => setLocation(`/opportunities/${opp.id}`)}
              className="w-full text-left group"
            >
              <div className="p-6 border bg-card rounded-lg hover:border-primary/50 transition-colors flex items-center justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 mb-1 flex-wrap">
                    {statusIcon(opp.status)}
                    <h2 className="text-base font-medium text-foreground group-hover:text-primary transition-colors truncate">
                      {opp.title}
                    </h2>
                    {opp.recommendationScore > 0 && fitBadge(
                      opp.recommendationScore >= 75 ? "strong" : opp.recommendationScore >= 50 ? "moderate" : opp.recommendationScore >= 25 ? "weak" : "no_bid",
                      opp.recommendationScore
                    )}
                    <Badge variant="secondary" className="text-xs font-normal shrink-0">
                      {statusLabel(opp.status)}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground truncate">
                    {opp.agency} · {opp.category}
                    {opp.deadline ? ` · Due ${format(new Date(opp.deadline), "MMM d, yyyy")}` : ""}
                    {opp.valueAmount ? ` · ${opp.valueAmount}` : ""}
                  </p>
                </div>
                <ChevronRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors flex-shrink-0 ml-4" />
              </div>
            </button>
          ))}
        </div>
      )}

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add Opportunity</DialogTitle>
          </DialogHeader>
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
              <Textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Paste a short summary of the opportunity..." />
            </div>
            <div className="space-y-1">
              <Label>Full RFP Text (optional — paste the entire RFP document)</Label>
              <Textarea rows={5} value={form.rawText} onChange={(e) => setForm({ ...form, rawText: e.target.value })} placeholder="Paste the full tender/RFP text here for better requirement extraction..." />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={createOpportunity.isPending}>
              {createOpportunity.isPending ? "Creating…" : "Create Opportunity"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
