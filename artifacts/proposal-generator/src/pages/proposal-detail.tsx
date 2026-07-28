import { useRoute, useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { 
  useGetProposal, 
  useUpdateProposal, 
  useDeleteProposal,
  useExportToGoogleDocs,
  getGetProposalQueryKey,
  getListProposalsQueryKey
} from "@workspace/api-client-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, Loader2, ArrowLeft, Trash2, CheckCircle2, Eye, Pencil, Sparkles, AlertCircle, ShieldCheck, Clock, AlertTriangle, Share2, RotateCcw } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { assembleProposalFromSections } from "@workspace/proposal-content";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useEffect, useRef, useState } from "react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const proposalSchema = z.object({
  clientName: z.string().min(1, "Client name is required"),
  industry: z.string().min(1, "Industry is required"),
  proposalContent: z.string().min(1, "Proposal content is required"),
});

type ProposalFormValues = z.infer<typeof proposalSchema>;

interface ProposalSection {
  id: number;
  proposalId: number;
  sectionKey: string;
  title: string;
  content: string;
  status: string;
  criticFindings: string | null;
  orderIndex: number;
  approvedAt?: string | null;
}

function sectionStatusBadge(status: string) {
  const cfg: Record<string, { label: string; className: string }> = {
    not_started: { label: "Not Started", className: "bg-muted text-muted-foreground border-border" },
    drafted: { label: "Drafted", className: "bg-blue-900/20 text-blue-300 border-blue-900" },
    needs_review: { label: "Needs Review", className: "bg-orange-900/20 text-orange-400 border-orange-900" },
    blocked_missing_input: { label: "Needs Input", className: "bg-red-900/20 text-red-400 border-red-900" },
    approved: { label: "Approved", className: "bg-green-900/20 text-green-400 border-green-900" },
  };
  const c = cfg[status] ?? { label: status, className: "bg-muted text-muted-foreground border-border" };
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${c.className}`}>
      {c.label}
    </span>
  );
}

function SectionsPanel({ proposalId }: { proposalId: number }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [editingSection, setEditingSection] = useState<ProposalSection | null>(null);
  const [editContent, setEditContent] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [showApproveDialog, setShowApproveDialog] = useState(false);

  const { data: sections, isLoading } = useQuery<ProposalSection[]>({
    queryKey: ["proposal-sections", proposalId],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/proposals/${proposalId}/sections`);
      if (!r.ok) throw new Error("Failed to load sections");
      return r.json();
    },
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 3000;
      const hasNotStarted = data.some((s) => s.status === "not_started" && !s.content);
      return hasNotStarted ? 3000 : false;
    },
  });

  const updateSection = useMutation({
    mutationFn: async ({ sectionId, content, status }: { sectionId: number; content?: string; status?: string }) => {
      const r = await fetch(`${BASE}/api/proposals/${proposalId}/sections/${sectionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, status }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}) as object) as { error?: string };
        if (body.error === "google_doc_canonical") {
          throw new Error("This proposal is in Google Docs. Edit it there instead.");
        }
        throw new Error("Failed to update section");
      }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["proposal-sections", proposalId] });
      setEditingSection(null);
      toast({ title: "Section saved" });
    },
    onError: (err) => toast({ title: "Save failed", description: (err as Error).message, variant: "destructive" }),
  });

  const runCritic = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${BASE}/api/proposals/${proposalId}/run-critic`, { method: "POST" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}) as object) as { error?: string };
        if (body.error === "google_doc_canonical") {
          throw new Error("This proposal is in Google Docs. Edit it there instead.");
        }
        throw new Error(body.error ?? "Critic failed");
      }
      return r.json();
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["proposal-sections", proposalId] });
      qc.invalidateQueries({ queryKey: getGetProposalQueryKey(proposalId) });
      const majorCount = data.summary?.filter((s: { severity: string }) => s.severity === "major").length ?? 0;
      toast({
        title: "Critic pass complete",
        description: majorCount > 0 ? `${majorCount} section(s) need review. Use Auto-Improve to fix them.` : "No major issues found.",
      });
    },
    onError: (err) => toast({ title: "Critic failed", description: (err as Error).message, variant: "destructive" }),
  });

  const autoImprove = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${BASE}/api/proposals/${proposalId}/ai-improve-sections`, { method: "POST" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}) as object) as { error?: string };
        if (body.error === "google_doc_canonical") {
          throw new Error("This proposal is in Google Docs. Edit it there instead.");
        }
        throw new Error(body.error ?? "Auto-improve failed");
      }
      return r.json();
    },
    onSuccess: (data) => {
      setTimeout(() => qc.invalidateQueries({ queryKey: ["proposal-sections", proposalId] }), 5000);
      toast({
        title: `Auto-improving ${data.count} section(s)…`,
        description: "AI is rewriting flagged sections. Refresh in ~30 seconds to see the results.",
        duration: 8000,
      });
    },
    onError: (err) => toast({ title: "Auto-improve failed", description: (err as Error).message, variant: "destructive" }),
  });

  const approveForExport = useMutation({
    mutationFn: async (overrideReason?: string) => {
      const r = await fetch(`${BASE}/api/proposals/${proposalId}/approve-for-export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(overrideReason ? { overrideReason } : {}),
      });
      const data = await r.json();
      if (!r.ok) {
        const err = data as { error?: string; blockers?: string[]; hint?: string };
        throw { message: err.error ?? "Approve failed", blockers: err.blockers ?? [] };
      }
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["proposal-sections", proposalId] });
      qc.invalidateQueries({ queryKey: getGetProposalQueryKey(proposalId) });
      qc.invalidateQueries({ queryKey: getListProposalsQueryKey() });
      setShowApproveDialog(false);
      toast({ title: "Proposal approved for export" });
    },
    onError: (err: { message?: string; blockers?: string[] } | unknown) => {
      const e = err as { message?: string; blockers?: string[] };
      if (e.blockers && e.blockers.length > 0) {
        setShowApproveDialog(true);
      } else {
        toast({ title: "Approve failed", description: e.message ?? "Unknown error", variant: "destructive" });
      }
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-3 mt-4">
        {[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full rounded-lg" />)}
      </div>
    );
  }

  if (!sections || sections.length === 0) {
    return (
      <div className="mt-4 p-6 border border-dashed rounded-lg bg-card/50 text-center text-sm text-muted-foreground">
        No sections yet. Generate a proposal from an Opportunity to produce section-by-section content.
      </div>
    );
  }

  const blockedCount = sections.filter((s) => s.status === "blocked_missing_input").length;
  const needsReviewCount = sections.filter((s) => s.status === "needs_review").length;
  const approvedCount = sections.filter((s) => s.status === "approved").length;
  const draftedCount = sections.filter((s) => s.status === "drafted").length;
  const generatingCount = sections.filter((s) => s.status === "not_started" && !s.content).length;

  return (
    <div className="space-y-4 mt-4">
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-3 text-xs text-muted-foreground">
          {generatingCount > 0 && <span className="text-yellow-400 animate-pulse">{generatingCount} generating…</span>}
          {draftedCount > 0 && <span>{draftedCount} drafted</span>}
          {blockedCount > 0 && <span className="text-red-400">{blockedCount} need input</span>}
          {needsReviewCount > 0 && <span className="text-orange-400">{needsReviewCount} need review</span>}
          {approvedCount > 0 && <span className="text-green-400">{approvedCount} approved</span>}
        </div>
        <div className="ml-auto flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => runCritic.mutate()}
            disabled={runCritic.isPending || generatingCount > 0}
          >
            {runCritic.isPending ? (
              <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />Running…</>
            ) : (
              <><Sparkles className="w-3.5 h-3.5 mr-1.5" />Run Critic</>
            )}
          </Button>
          {needsReviewCount > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => autoImprove.mutate()}
              disabled={autoImprove.isPending || generatingCount > 0}
              className="border-orange-700 text-orange-400 hover:bg-orange-900/20"
            >
              {autoImprove.isPending ? (
                <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />Improving…</>
              ) : (
                <><Sparkles className="w-3.5 h-3.5 mr-1.5" />Auto-Improve ({needsReviewCount})</>
              )}
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => approveForExport.mutate(undefined)}
            disabled={approveForExport.isPending || generatingCount > 0}
          >
            {approveForExport.isPending ? (
              <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />Checking…</>
            ) : (
              <><ShieldCheck className="w-3.5 h-3.5 mr-1.5" />Approve for Export</>
            )}
          </Button>
        </div>
      </div>

      {/* Section list */}
      <div className="space-y-3">
        {sections.map((section) => (
          <div key={section.id} className="border rounded-lg bg-card overflow-hidden">
            <div className="flex items-start gap-3 p-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="text-xs font-medium text-muted-foreground">{section.orderIndex + 1}.</span>
                  <span className="text-sm font-medium text-foreground">{section.title}</span>
                  {sectionStatusBadge(section.status)}
                </div>
                {section.criticFindings && (
                  <div className="mt-2 p-2.5 rounded bg-orange-900/10 border border-orange-900/30 text-xs text-orange-300 space-y-1">
                    <div className="flex items-center gap-1.5 font-medium mb-1">
                      <AlertCircle className="w-3 h-3" /> Critic findings
                    </div>
                    <div className="whitespace-pre-wrap">{section.criticFindings}</div>
                  </div>
                )}
                {section.content && section.status !== "not_started" && (
                  <p className="mt-2 text-xs text-muted-foreground line-clamp-2">
                    {section.content.replace(/^#+\s.+\n?/m, "").replace(/\*\*/g, "").substring(0, 160)}…
                  </p>
                )}
                {section.status === "not_started" && !section.content && (
                  <p className="mt-1.5 text-xs text-muted-foreground animate-pulse">Generating…</p>
                )}
              </div>
              <div className="flex gap-1.5 ml-2 flex-shrink-0">
                {section.status !== "approved" && section.content && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() => {
                      updateSection.mutate({ sectionId: section.id, status: "approved" });
                    }}
                    disabled={updateSection.isPending}
                  >
                    <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => {
                    setEditingSection(section);
                    setEditContent(section.content);
                  }}
                  disabled={!section.content}
                >
                  <Pencil className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Edit section dialog */}
      <Dialog open={!!editingSection} onOpenChange={(o) => !o && setEditingSection(null)}>
        <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="w-4 h-4" />
              {editingSection?.title}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {editingSection?.criticFindings && (
              <div className="p-3 rounded bg-orange-900/10 border border-orange-900/30 text-xs text-orange-300">
                <div className="font-medium mb-1">Critic findings to address:</div>
                <div className="whitespace-pre-wrap">{editingSection.criticFindings}</div>
              </div>
            )}
            <Textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="min-h-[50vh] font-mono text-sm leading-relaxed"
            />
            <p className="text-xs text-muted-foreground">
              Use Markdown. Replace <code className="bg-muted px-1 rounded">[NEEDS ONWRD INPUT: …]</code> with actual content.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditingSection(null)}>Cancel</Button>
            <Button
              variant="secondary"
              onClick={() => editingSection && updateSection.mutate({ sectionId: editingSection.id, content: editContent, status: "drafted" })}
              disabled={updateSection.isPending}
            >
              Save as Draft
            </Button>
            <Button
              onClick={() => editingSection && updateSection.mutate({ sectionId: editingSection.id, content: editContent, status: "approved" })}
              disabled={updateSection.isPending}
            >
              {updateSection.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <><CheckCircle2 className="w-4 h-4 mr-1.5" />Save & Approve</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Override approval dialog */}
      <Dialog open={showApproveDialog} onOpenChange={setShowApproveDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Quality Gate Issues</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              Some sections have unresolved issues. Provide a reason to override and export anyway.
            </p>
            <div className="space-y-1">
              <Label>Override Reason</Label>
              <Textarea
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                placeholder="e.g. Deadline is today, placeholders will be filled in the Google Doc manually."
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowApproveDialog(false)}>Cancel</Button>
            <Button
              onClick={() => {
                approveForExport.mutate(overrideReason || "Override by user");
              }}
              disabled={approveForExport.isPending}
            >
              Override & Approve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function ProposalDetail() {
  const [, params] = useRoute("/proposals/:id");
  const id = Number(params?.id);
  const [, setLocation] = useLocation();
  const [previewMode, setPreviewMode] = useState(false);
  const [activeTab, setActiveTab] = useState<"preview" | "sections">("preview");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: proposal, isLoading } = useGetProposal(id);
  const updateProposal = useUpdateProposal();
  const deleteProposal = useDeleteProposal();
  const exportToDocs = useExportToGoogleDocs();

  const { data: sections, isSuccess: sectionsLoaded } = useQuery<ProposalSection[]>({
    queryKey: ["proposal-sections", id],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/proposals/${id}/sections`);
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !isNaN(id),
  });

  const { data: driveConfig } = useQuery<{ folderId: string | null; folderName: string | null }>({
    queryKey: ["drive-config"],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/settings/google-drive`);
      if (!r.ok) return { folderId: null, folderName: null };
      return r.json();
    },
  });

  // Derived from proposal
  const linkedTenderId = (proposal as Record<string, unknown> | undefined)?.tenderId as number | null | undefined;
  const generationStatus = (proposal as Record<string, unknown> | undefined)?.generationStatus as string | null | undefined;

  const hasSections = sectionsLoaded && sections && sections.length > 0;

  const form = useForm<ProposalFormValues>({
    resolver: zodResolver(proposalSchema),
    defaultValues: {
      clientName: "",
      industry: "",
      proposalContent: "",
    }
  });

  const initializedRef = useRef(false);
  const prevStatusRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!proposal) return;
    const prevStatus = prevStatusRef.current;
    prevStatusRef.current = proposal.status;

    if (!initializedRef.current) {
      form.reset({
        clientName: proposal.clientName,
        industry: proposal.industry,
        proposalContent: proposal.proposalContent,
      });
      initializedRef.current = true;
      return;
    }

    // When generation completes (was drafting, now terminal), sync only if
    // the user has not made local edits.
    if (
      prevStatus === "proposal_drafting" &&
      (proposal.status as string) !== "proposal_drafting" &&
      !form.formState.isDirty
    ) {
      form.reset({
        clientName: proposal.clientName,
        industry: proposal.industry,
        proposalContent: proposal.proposalContent,
      });
    }
  }, [proposal, form]);

  // ── Continuous polling while proposal is being generated ──────────────────
  const isDrafting = (proposal?.status as string | undefined) === "proposal_drafting";
  const isGenActive = isDrafting || ["extracting", "strategizing", "drafting"].includes(generationStatus ?? "");
  useEffect(() => {
    if (!isGenActive) return;
    const poll = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: getGetProposalQueryKey(id) });
      void queryClient.invalidateQueries({ queryKey: ["proposal-sections", id] });
    }, 2500);
    return () => clearInterval(poll);
  }, [isGenActive, id, queryClient]);

  // ── Auto-switch to preview when generation completes ─────────────────────
  useEffect(() => {
    if (generationStatus === "ready" && hasSections) {
      setActiveTab("preview");
    }
  }, [generationStatus, hasSections]);

  const isFreeform = sectionsLoaded && (!sections || sections.length === 0) && !isDrafting;

  const handleSave = (values: ProposalFormValues) => {
    updateProposal.mutate({
      id,
      data: values
    }, {
      onSuccess: (data) => {
        queryClient.setQueryData(getGetProposalQueryKey(id), data);
        queryClient.invalidateQueries({ queryKey: getListProposalsQueryKey() });
        toast({
          title: "Saved",
          description: "Changes saved successfully.",
        });
      },
      onError: (error) => {
        const apiData = (error as { data?: { code?: string; googleDocUrl?: string } }).data;
        if (apiData?.code === "google_doc_canonical") {
          toast({
            title: "Editing locked",
            description: (
              <div className="flex flex-col gap-2 mt-1">
                <p>This proposal lives in Google Docs — edit it there.</p>
                {apiData.googleDocUrl && (
                  <a href={apiData.googleDocUrl} target="_blank" rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs underline underline-offset-2">
                    <ExternalLink className="w-3 h-3" />
                    Open Google Doc
                  </a>
                )}
              </div>
            ),
            variant: "destructive",
          });
          return;
        }
        toast({
          title: "Save failed",
          description: (error as Error).message || "Could not save changes.",
          variant: "destructive"
        });
      }
    });
  };

  const handleHandoff = () => {
    exportToDocs.mutate({ id }, {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: getGetProposalQueryKey(id) });
        queryClient.invalidateQueries({ queryKey: getListProposalsQueryKey() });
        const d = data as { docUrl?: string; alreadyComplete?: boolean };
        if (d.alreadyComplete && d.docUrl) {
          window.open(d.docUrl, "_blank");
          return;
        }
        toast({
          title: "Shared for team review",
          description: (
            <div className="flex flex-col gap-2 mt-2">
              <p>Google Doc created in your configured Drive folder.</p>
              <Button variant="outline" size="sm" asChild className="w-fit">
                <a href={d.docUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2">
                  <ExternalLink className="w-4 h-4" />
                  Open Google Doc
                </a>
              </Button>
            </div>
          ),
          duration: 10000,
        });
      },
      onError: (error) => {
        queryClient.invalidateQueries({ queryKey: getGetProposalQueryKey(id) });
        const status = (error as { status?: number }).status;
        const title =
          status === 422 ? "Draft not ready" :
          status === 409 ? "Handoff in progress" :
          status === 400 ? "Configuration required" :
          status === 401 ? "Google account disconnected" :
          "Share failed";
        const description =
          status === 422 ? "The proposal has no content ready to export. Wait for generation to complete or add content first." :
          status === 409 ? "A handoff is already running for this proposal. Try again in a moment." :
          status === 400 ? ((error as { error?: string }).error || "No Google Drive folder configured. Set a destination in Settings first.") :
          status === 401 ? "Your Google account is not connected. Reconnect it in Settings → Google Docs." :
          (error as { error?: string }).error || "Could not share to Google Docs. Make sure your Google account is connected in Settings.";
        toast({ title, description, variant: "destructive" });
      }
    });
  };

  const handleDelete = () => {
    deleteProposal.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListProposalsQueryKey() });
        toast({
          title: "Deleted",
          description: "Proposal has been deleted.",
        });
        setLocation("/");
      },
      onError: (error) => {
        toast({
          title: "Delete failed",
          description: (error as { error?: string }).error || "Could not delete proposal.",
          variant: "destructive"
        });
      }
    });
  };

  if (isLoading) {
    return (
      <div className="p-8 max-w-5xl mx-auto space-y-6">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-12 w-2/3" />
        <div className="grid grid-cols-2 gap-6">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
        <Skeleton className="h-[600px] w-full" />
      </div>
    );
  }

  if (!proposal) {
    return (
      <div className="p-8 max-w-5xl mx-auto text-center py-20">
        <h2 className="text-2xl font-semibold mb-4">Proposal not found</h2>
        <Button onClick={() => setLocation("/")} variant="outline">
          Return to Dashboard
        </Button>
      </div>
    );
  }

  const statusLabel: Record<string, string> = {
    draft: "Draft",
    exported: "Exported",
    proposal_drafting: "Drafting",
    needs_onwrd_input: "Needs Input",
    ready_for_review: "Ready for Review",
    approved_for_export: "Approved",
    exported_to_drive: "Exported",
  };

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="mb-6 flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={() => setLocation("/")} className="gap-2">
          <ArrowLeft className="w-4 h-4" />
          Back
        </Button>
        <Badge variant={proposal.status === "exported" || proposal.status === "exported_to_drive" ? "success" : "default"}>
          {statusLabel[proposal.status] ?? proposal.status}
        </Badge>
        {proposal.status === "approved_for_export" && (
          <Badge className="bg-green-900/20 text-green-400 border-green-900">
            <ShieldCheck className="w-3 h-3 mr-1" /> Approved
          </Badge>
        )}
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <h1 className="text-4xl font-bold text-white tracking-tight">
          {hasSections ? "Proposal Desk" : "Edit Proposal"}
        </h1>
        <div className="flex items-center gap-3">
          {proposal.googleDocUrl && (
            <Button variant="outline" asChild data-testid="button-open-doc">
              <a href={proposal.googleDocUrl} target="_blank" rel="noopener noreferrer" className="gap-2">
                <ExternalLink className="w-4 h-4" />
                Open Doc
              </a>
            </Button>
          )}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="icon" data-testid="button-delete">
                <Trash2 className="w-4 h-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Are you sure?</AlertDialogTitle>
                <AlertDialogDescription>
                  This action cannot be undone. This will permanently delete the proposal from the system.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction 
                  onClick={handleDelete} 
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  data-testid="button-confirm-delete"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* ── Generation status panel — shown when linked to an Opportunity ──────── */}
      {linkedTenderId && (
        <div className="mb-6 p-4 border border-primary/20 rounded-lg bg-primary/5">
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-muted-foreground flex-1 min-w-0">
              Linked to Opportunity <span className="text-foreground font-medium">#{linkedTenderId}</span>
            </p>
            {(() => {
              if (generationStatus === "extracting") {
                return (
                  <span className="inline-flex items-center gap-1.5 text-sm text-blue-400" data-testid="gen-status-text">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Extracting requirements…
                  </span>
                );
              }
              if (generationStatus === "strategizing") {
                return (
                  <span className="inline-flex items-center gap-1.5 text-sm text-violet-400" data-testid="gen-status-text">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Building strategy…
                  </span>
                );
              }
              if (generationStatus === "drafting" || isDrafting) {
                return (
                  <span className="inline-flex items-center gap-1.5 text-sm text-amber-400" data-testid="gen-status-text">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Writing draft…
                  </span>
                );
              }
              if (generationStatus === "ready") {
                return (
                  <span className="inline-flex items-center gap-1.5 text-sm text-emerald-400" data-testid="gen-status-text">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Proposal ready
                  </span>
                );
              }
              if (generationStatus === "failed") {
                return (
                  <span className="inline-flex items-center gap-1.5 text-sm text-red-400" data-testid="gen-status-text">
                    <AlertCircle className="w-3.5 h-3.5" /> Generation failed — retry from Proposals
                  </span>
                );
              }
              return null;
            })()}
          </div>
        </div>
      )}

      <Form {...form}>
        <form className="space-y-6" onSubmit={form.handleSubmit(handleSave)}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 bg-card p-6 border rounded-lg">
            <FormField
              control={form.control}
              name="clientName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Client Name</FormLabel>
                  <FormControl>
                    <Input {...field} data-testid="input-client-name" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="industry"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Industry</FormLabel>
                  <FormControl>
                    <Input {...field} data-testid="input-industry" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          {proposal.briefText && (
            <div className="bg-card border rounded-lg overflow-hidden">
              <div className="bg-muted p-4 border-b">
                <Label className="font-semibold text-foreground">Client Brief</Label>
                <p className="text-xs text-muted-foreground mt-0.5">Original intake form submission — read only</p>
              </div>
              <pre className="p-6 text-sm text-muted-foreground whitespace-pre-wrap font-sans leading-relaxed">
                {proposal.briefText}
              </pre>
            </div>
          )}

          {/* Tab switcher removed — sections are accessible via the Edit Sections disclosure below */}

          {/* Content area — preview always shown; edit sections via disclosure below */}
          {hasSections ? (
            /* Full Proposal Preview — always shown when sections exist */
            <div className="bg-card border rounded-lg overflow-hidden flex flex-col">
              <div className="bg-muted p-4 border-b flex items-center justify-between">
                <Label className="font-semibold text-foreground">Full Proposal Preview</Label>
                <img src="/onwrd-logo-white.png" alt="ONWRD" className="h-7 object-contain" />
              </div>
              <div
                className="min-h-[600px] p-8 font-sans text-base leading-relaxed prose prose-sm prose-invert max-w-none
                  [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm
                  [&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold
                  [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_td]:align-top
                  [&_tr:nth-child(even)_td]:bg-muted/30"
              >
                {isDrafting ? (
                  <div className="flex items-center gap-3 text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Generating proposal sections…</span>
                  </div>
                ) : sections && sections.some((s) => s.content && s.content.trim()) ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {assembleProposalFromSections(
                      sections
                        .filter((s) => s.content && s.content.trim())
                        .map((s) => ({ title: s.title, content: s.content, orderIndex: s.orderIndex }))
                    )}
                  </ReactMarkdown>
                ) : (
                  <p className="text-muted-foreground">No content yet. Generate a draft from an Opportunity.</p>
                )}
              </div>
            </div>
          ) : isFreeform ? (
            /* Freeform editor — proposal not linked to sections */
            <div className="bg-card border rounded-lg overflow-hidden flex flex-col">
              <div className="bg-muted p-4 border-b flex items-center justify-between">
                <Label className="font-semibold text-foreground">Document Content</Label>
                <div className="flex items-center gap-3">
                  <div className="flex rounded-md border overflow-hidden text-sm">
                    <button
                      type="button"
                      onClick={() => setPreviewMode(false)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 transition-colors ${
                        !previewMode
                          ? "bg-primary text-primary-foreground"
                          : "bg-background text-muted-foreground hover:bg-accent"
                      }`}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => setPreviewMode(true)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 transition-colors ${
                        previewMode
                          ? "bg-primary text-primary-foreground"
                          : "bg-background text-muted-foreground hover:bg-accent"
                      }`}
                    >
                      <Eye className="w-3.5 h-3.5" />
                      Preview
                    </button>
                  </div>
                  <img src="/onwrd-logo-white.png" alt="ONWRD" className="h-7 object-contain" />
                </div>
              </div>
              <FormField
                control={form.control}
                name="proposalContent"
                render={({ field }) => (
                  <FormItem className="flex-1 space-y-0">
                    <FormControl>
                      {previewMode ? (
                        <div
                          className="min-h-[600px] p-8 font-sans text-base leading-relaxed prose prose-sm prose-invert max-w-none
                            [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm
                            [&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold
                            [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_td]:align-top
                            [&_tr:nth-child(even)_td]:bg-muted/30"
                        >
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {field.value}
                          </ReactMarkdown>
                        </div>
                      ) : (
                        <Textarea
                          {...field}
                          className="min-h-[600px] border-0 focus-visible:ring-0 rounded-none resize-y p-8 font-sans text-base leading-relaxed"
                          data-testid="input-proposal-content"
                        />
                      )}
                    </FormControl>
                    <FormMessage className="px-8 pb-4" />
                  </FormItem>
                )}
              />
            </div>
          ) : (
            /* Loading state — sections fetch in flight or isDrafting with no sections yet */
            <div className="bg-card border rounded-lg min-h-[200px] flex items-center justify-center">
              <div className="flex items-center gap-3 text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Loading…</span>
              </div>
            </div>
          )}

          {/* ── Edit Sections disclosure ──────────────────────────────────── */}
          {hasSections && (
            <div className="mt-4">
              <button
                type="button"
                className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors py-2"
                onClick={() => setActiveTab(activeTab === "sections" ? "preview" : "sections")}
              >
                <Sparkles className="w-3.5 h-3.5" />
                {activeTab === "sections" ? "Hide Sections" : "Edit Sections"}
                {sections.filter((s) => s.status === "blocked_missing_input" || s.status === "needs_review").length > 0 && (
                  <span className="ml-1 bg-orange-500 text-white rounded-full w-4 h-4 flex items-center justify-center text-[10px] font-bold">
                    {sections.filter((s) => s.status === "blocked_missing_input" || s.status === "needs_review").length}
                  </span>
                )}
              </button>
              {activeTab === "sections" && <SectionsPanel proposalId={id} />}
            </div>
          )}

          {(
            <div className="pt-4 space-y-3">
              {/* ── Google Doc status panel ─────────────────────────────────── */}
              {(() => {
                const isComplete = proposal.syncStatus === "handoff_complete";
                const isPending = proposal.syncStatus === "pending_first_write";
                const isInProgress = proposal.syncStatus === "handoff_in_progress";
                const isLegacy = !!proposal.googleFileId && !isComplete && !isPending && !isInProgress;

                if (isComplete) {
                  return (
                    <div className="flex flex-wrap items-center gap-3 text-sm bg-card border rounded-lg px-4 py-3">
                      <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />
                      <span className="text-muted-foreground">
                        Shared for team review
                        {proposal.lastSyncedAt && (
                          <> — <span className="text-foreground">{new Date(proposal.lastSyncedAt).toLocaleString()}</span></>
                        )}
                      </span>
                    </div>
                  );
                }
                if (isPending) {
                  return (
                    <div className="flex flex-wrap items-center gap-3 text-sm bg-card border border-orange-900/40 rounded-lg px-4 py-3">
                      <AlertTriangle className="w-4 h-4 text-orange-400 shrink-0" />
                      <span className="text-orange-400 font-medium">First write failed — document created but content not yet written.</span>
                    </div>
                  );
                }
                if (isInProgress) {
                  return (
                    <div className="flex flex-wrap items-center gap-3 text-sm bg-card border rounded-lg px-4 py-3">
                      <Loader2 className="w-4 h-4 animate-spin text-muted-foreground shrink-0" />
                      <span className="text-muted-foreground">Sharing…</span>
                    </div>
                  );
                }
                if (isLegacy) {
                  return (
                    <div className="flex flex-wrap items-center gap-3 text-sm bg-card border rounded-lg px-4 py-3">
                      <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />
                      <span className="text-muted-foreground">Linked to Google Docs</span>
                      {proposal.lastSyncedAt && (
                        <>
                          <Clock className="w-4 h-4 text-muted-foreground shrink-0" />
                          <span className="text-muted-foreground">
                            Shared for team review — {new Date(proposal.lastSyncedAt).toLocaleString()}
                          </span>
                        </>
                      )}
                    </div>
                  );
                }
                // No doc yet — show destination status
                return (
                  <div className="flex flex-wrap items-center gap-3 text-sm bg-card border rounded-lg px-4 py-3">
                    {driveConfig?.folderId ? (
                      <>
                        <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />
                        <span className="text-muted-foreground">
                          Destination:{" "}
                          <span className="text-foreground font-medium">
                            {driveConfig.folderName ?? driveConfig.folderId}
                          </span>
                        </span>
                      </>
                    ) : (
                      <>
                        <AlertTriangle className="w-4 h-4 text-orange-400 shrink-0" />
                        <span className="text-orange-400 font-medium">No destination folder configured</span>
                      </>
                    )}
                    <a
                      href="/settings"
                      className="ml-auto text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                    >
                      Change in Settings
                    </a>
                  </div>
                );
              })()}

              <div className="flex justify-end gap-4">
                <Button
                  type="submit"
                  variant="secondary"
                  disabled={updateProposal.isPending || exportToDocs.isPending}
                  data-testid="button-save"
                >
                  {updateProposal.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  Save Changes
                </Button>

                {/* Open Google Doc — completed or legacy (direct URL, no API call) */}
                {(proposal.syncStatus === "handoff_complete" || (!!proposal.googleFileId && proposal.syncStatus !== "pending_first_write" && proposal.syncStatus !== "handoff_in_progress")) && (
                  <Button
                    type="button"
                    variant="outline"
                    asChild
                    data-testid="button-open-doc"
                  >
                    <a
                      href={proposal.googleDocUrl ?? `https://docs.google.com/document/d/${proposal.googleFileId}/edit`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink className="w-4 h-4 mr-2" />
                      Open Google Doc
                    </a>
                  </Button>
                )}

                {/* Retry — only when pending_first_write */}
                {proposal.syncStatus === "pending_first_write" && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleHandoff}
                    disabled={exportToDocs.isPending}
                    data-testid="button-retry"
                    className="border-orange-700 text-orange-400 hover:bg-orange-900/20"
                  >
                    {exportToDocs.isPending ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <RotateCcw className="w-4 h-4 mr-2" />
                    )}
                    Retry Share
                  </Button>
                )}

                {/* Share for Team Review — only when no doc yet */}
                {!proposal.googleFileId && proposal.syncStatus !== "handoff_in_progress" && (() => {
                  const PLACEHOLDER = /generating proposal sections/i;
                  const isMeaningful = (t: string | null | undefined) => !!(t?.trim()) && !PLACEHOLDER.test(t.trim());
                  const hasMeaningSections = sections?.some((s) => isMeaningful(s.content)) ?? false;
                  const hasNoReadyContent = !hasMeaningSections && !isMeaningful(proposal.proposalContent);
                  return (
                  <Button
                    type="button"
                    disabled={updateProposal.isPending || exportToDocs.isPending || !driveConfig?.folderId || (proposal.status as string) === "proposal_drafting" || hasNoReadyContent}
                    onClick={handleHandoff}
                    className="bg-[#0000FF] hover:bg-[#0000FF] text-white border border-[#0000FF] disabled:opacity-50"
                    data-testid="button-share"
                    title={
                      (proposal.status as string) === "proposal_drafting"
                        ? "Wait for generation to complete before sharing"
                        : hasNoReadyContent
                        ? "No content ready — generate or add proposal content first"
                        : !driveConfig?.folderId
                        ? "Configure a destination folder in Settings first"
                        : undefined
                    }
                  >
                    {exportToDocs.isPending ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <Share2 className="w-4 h-4 mr-2" />
                    )}
                    Share for Team Review
                  </Button>
                  );
                })()}
              </div>
            </div>
          )}
        </form>
      </Form>
    </div>
  );
}
