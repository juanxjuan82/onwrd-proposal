import { useState, useEffect, useRef } from "react";
import { useLocation, useSearch } from "wouter";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  useParseBrief,
  useCreateProposal,
  useExportToGoogleDocs,
  getListProposalsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  ExternalLink,
  Loader2,
  CheckCircle2,
  FileText,
  Eye,
  Pencil,
  UploadCloud,
  X,
  ClipboardList,
  ChevronDown,
} from "lucide-react";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// ─── Intake form schema ────────────────────────────────────────────────────
const intakeSchema = z.object({
  orgName: z.string().min(1, "Organisation name is required"),
  website: z.string().optional(),
  industry: z.string().min(1, "Industry / service category is required"),
  yearsOperating: z.string().min(1, "Please select how long you've been operating"),
  objectives: z.array(z.string()).min(1, "Please select at least one marketing objective"),
  objectivesOther: z.string().optional(),
  services: z.array(z.string()).min(1, "Please select at least one service area"),
  servicesOther: z.string().optional(),
  challenges: z.string().min(1, "Please describe your marketing challenges"),
  successCriteria: z.string().min(1, "Please describe your success criteria"),
  idealStart: z.string().min(1, "Please select your ideal start time"),
});

type IntakeValues = z.infer<typeof intakeSchema>;

// ─── Proposal editor schema ────────────────────────────────────────────────
const proposalSchema = z.object({
  clientName: z.string().min(1, "Client name is required"),
  industry: z.string().min(1, "Industry is required"),
  proposalContent: z.string().min(1, "Proposal content is required"),
});

type ProposalFormValues = z.infer<typeof proposalSchema>;

// ─── Options ──────────────────────────────────────────────────────────────
const YEARS_OPTIONS = [
  "Less than 1 year",
  "1–3 years",
  "3–5 years",
  "5–10 years",
  "10+ years",
];

const OBJECTIVE_OPTIONS = [
  "Brand Awareness",
  "Lead Generation",
  "Customer Retention",
  "Social Media Presence",
  "Increased Website Traffic",
  "Sales Conversion",
  "Thought Leadership",
  "Other",
];

const SERVICE_OPTIONS = [
  "Marketing Communication Strategy",
  "Content Marketing & Creation",
  "Public Relations",
  "Graphic Design",
  "Website Design & Development",
  "Other",
];

const START_OPTIONS = [
  "Immediately",
  "Within 1 month",
  "1–3 months",
  "3–6 months",
  "Not yet decided",
];

// ─── Format intake data → brief text for the AI ───────────────────────────
function formatBrief(v: IntakeValues): string {
  const today = new Date().toISOString().split("T")[0];

  const objectives = [
    ...v.objectives.filter((o) => o !== "Other"),
    ...(v.objectives.includes("Other") && v.objectivesOther
      ? [v.objectivesOther]
      : []),
  ].join(", ");

  const services = [
    ...v.services.filter((s) => s !== "Other"),
    ...(v.services.includes("Other") && v.servicesOther
      ? [v.servicesOther]
      : []),
  ].join(", ");

  return `Project Brief

Date: ${today}
Potential Client: ${v.orgName}
Project Name: ${v.orgName}

Company Information
Company: ${v.orgName}
Website: ${v.website || "n/a"}
Service Category: ${v.industry}
Product/Service Description: ${v.yearsOperating}, ${v.industry}

Project Information
Marketing Objectives: ${objectives}
Assistance Needed: ${services}, ${v.challenges}
Success Criteria: ${v.successCriteria}

Deliverables
${v.challenges}

Timing and Key Dates
Ideal time to start: ${v.idealStart}
Proposal submission (ONWRD → Client): ${today} + 10 days
`.trim();
}

// ─── Checkbox group helper ─────────────────────────────────────────────────
function CheckboxGroup({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string[];
  onChange: (val: string[]) => void;
}) {
  const toggle = (opt: string) => {
    onChange(
      value.includes(opt) ? value.filter((v) => v !== opt) : [...value, opt],
    );
  };
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {options.map((opt) => (
        <label
          key={opt}
          className={`flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-sm cursor-pointer transition-colors
            ${value.includes(opt) ? "border-primary bg-primary/5 text-primary font-medium" : "border-border bg-background hover:border-primary/40"}`}
        >
          <input
            type="checkbox"
            className="accent-primary"
            checked={value.includes(opt)}
            onChange={() => toggle(opt)}
          />
          {opt}
        </label>
      ))}
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────
export default function NewProposal() {
  const [step, setStep] = useState<1 | 2>(1);
  const [briefText, setBriefText] = useState("");
  const [isExporting, setIsExporting] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);
  const search = useSearch();
  const [mode, setMode] = useState<"form" | "paste" | "import" | "blank" | "manual">(() => {
    const m = new URLSearchParams(search).get("mode");
    if (m === "paste")  return "paste";
    if (m === "import") return "import";
    if (m === "blank")  return "blank";
    if (m === "manual") return "manual";
    if (m === "form")   return "form";
    return "blank"; // plain /new → blank mode per spec
  });
  const [pasteText, setPasteText] = useState("");
  const [pasteFile, setPasteFile] = useState<File | null>(null);
  const [showRfpSources, setShowRfpSources] = useState(false);
  const [pasteFileExtracting, setPasteFileExtracting] = useState(false);
  const [pasteFileError, setPasteFileError] = useState<string | null>(null);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [briefCheck, setBriefCheck] = useState<{ sufficient: boolean; missing: string[]; summary: string } | null>(null);
  const [briefChecking, setBriefChecking] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const [creatingOpportunity, setCreatingOpportunity] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const checkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, setLocation] = useLocation();

  // Redirect plain /new → /new?mode=blank so the URL always reflects the active mode
  useEffect(() => {
    if (!new URLSearchParams(search).get("mode")) {
      setLocation("/new?mode=blank", { replace: true });
    }
  }, []);

  const { toast } = useToast();
  const queryClient = useQueryClient();

  const parseBrief = useParseBrief();
  const createProposal = useCreateProposal();
  const exportToDocs = useExportToGoogleDocs();

  // Intake form
  const intake = useForm<IntakeValues>({
    resolver: zodResolver(intakeSchema),
    defaultValues: {
      orgName: "",
      website: "",
      industry: "",
      yearsOperating: "",
      objectives: [],
      objectivesOther: "",
      services: [],
      servicesOther: "",
      challenges: "",
      successCriteria: "",
      idealStart: "",
    },
  });

  // Proposal editor form
  const form = useForm<ProposalFormValues>({
    resolver: zodResolver(proposalSchema),
    defaultValues: { clientName: "", industry: "", proposalContent: "" },
  });

  // Progress bar
  const ESTIMATED_SECONDS = 50;
  const STATUS_MESSAGES = [
    "Reading your brief...",
    "Identifying opportunities...",
    "Building strategic approach...",
    "Scoping phases of work...",
    "Structuring investment and timeline...",
    "Drafting proposal document...",
    "Finalising proposal...",
  ];
  const [genProgress, setGenProgress] = useState(0);
  const genIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const genStartRef = useRef<number>(0);

  useEffect(() => {
    if (parseBrief.isPending) {
      setGenProgress(0);
      genStartRef.current = Date.now();
      genIntervalRef.current = setInterval(() => {
        const elapsed = (Date.now() - genStartRef.current) / 1000;
        setGenProgress(Math.min((elapsed / ESTIMATED_SECONDS) * 95, 95));
      }, 200);
    } else {
      if (genIntervalRef.current) {
        clearInterval(genIntervalRef.current);
        genIntervalRef.current = null;
      }
      setGenProgress(0);
    }
    return () => {
      if (genIntervalRef.current) clearInterval(genIntervalRef.current);
    };
  }, [parseBrief.isPending]);

  useEffect(() => {
    if (mode !== "paste") return;
    if (checkTimerRef.current) clearTimeout(checkTimerRef.current);
    if (pasteText.trim().length < 30) {
      setBriefCheck(null);
      return;
    }
    checkTimerRef.current = setTimeout(async () => {
      setBriefChecking(true);
      try {
        const resp = await fetch(`${BASE}/api/proposals/check-brief`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: pasteText }),
        });
        const data = await resp.json() as { sufficient?: boolean; missing?: string[]; summary?: string; error?: string };
        if (resp.ok) {
          setBriefCheck({
            sufficient: data.sufficient ?? false,
            missing: data.missing ?? [],
            summary: data.summary ?? "",
          });
        }
      } finally {
        setBriefChecking(false);
      }
    }, 1500);
    return () => { if (checkTimerRef.current) clearTimeout(checkTimerRef.current); };
  }, [pasteText, mode]);

  const handleFileSelect = async (file: File) => {
    setPasteFile(file);
    setPasteFileError(null);
    if (file.name.match(/\.txt$/i)) {
      const text = await file.text();
      setPasteText(text.trim());
      return;
    }
    setPasteFileExtracting(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const resp = await fetch(`${BASE}/api/proposals/extract-text`, { method: "POST", body: fd });
      const data = await resp.json() as { text?: string; error?: string };
      if (!resp.ok) throw new Error(data.error ?? "Extraction failed");
      setPasteText(data.text ?? "");
    } catch (e) {
      setPasteFileError(e instanceof Error ? e.message : "Could not read file");
      setPasteFile(null);
    } finally {
      setPasteFileExtracting(false);
    }
  };

  const handlePasteSubmit = () => {
    if (!pasteText.trim()) {
      setPasteError("Please paste some text or upload a document first.");
      return;
    }
    setPasteError(null);
    const brief = pasteText.trim();
    setBriefText(brief);
    parseBrief.mutate(
      { data: { briefText: brief } },
      {
        onSuccess: (data) => {
          form.setValue("clientName", data.clientName);
          form.setValue("industry", data.industry);
          form.setValue("proposalContent", data.proposalContent);
          setStep(2);
        },
        onError: (error) => {
          toast({ title: "Generation failed", description: (error as { error?: string }).error ?? "An unexpected error occurred.", variant: "destructive" });
        },
      },
    );
  };

  // ── Create a canonical Opportunity from pasted text ──────────────────────
  const handlePasteAsOpportunity = async () => {
    if (!pasteText.trim()) {
      setPasteError("Please paste some text or upload a document first.");
      return;
    }
    setPasteError(null);
    const rawText = pasteText.trim();
    const lines = rawText.split("\n").filter(Boolean);
    const title = (lines[0] ?? "Pasted RFP").slice(0, 100);

    setCreatingOpportunity(true);
    try {
      const res = await fetch(`${BASE}/api/opportunities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          agency: "Unknown",
          description: rawText.slice(0, 500),
          rawText,
          sourceType: "pasted_text",
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: number; error?: string };
      if (!res.ok) {
        toast({ title: "Failed to create opportunity", description: body.error ?? "Unknown error", variant: "destructive" });
        return;
      }
      toast({ title: "Opportunity created", description: "Ready to generate a proposal." });
      setLocation(`/proposals?opportunity=${body.id ?? ""}`);
    } finally {
      setCreatingOpportunity(false);
    }
  };

  // ── Create a canonical Opportunity from file or URL import ───────────────
  const handleImportAsOpportunity = async () => {
    const hasUrl  = importUrl.trim().length > 0;
    const hasFile = pasteText.trim().length > 0 || pasteFile !== null;

    if (!hasUrl && !hasFile) {
      setPasteError("Please upload a file or enter a URL.");
      return;
    }
    setPasteError(null);

    const rawText   = pasteText.trim();
    const sourceType = hasUrl ? "url" : "rfp_upload";
    const sourceUrl  = hasUrl ? importUrl.trim() : undefined;
    const lines      = rawText.split("\n").filter(Boolean);
    const title      = (lines[0] ?? (hasUrl ? importUrl.trim().slice(0, 100) : "Imported RFP")).slice(0, 100);

    setCreatingOpportunity(true);
    try {
      const res = await fetch(`${BASE}/api/opportunities`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          agency: "Unknown",
          description: rawText.slice(0, 500) || `Imported from ${sourceUrl ?? "file"}`,
          rawText: rawText || undefined,
          sourceType,
          sourceUrl,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: number; error?: string };
      if (!res.ok) {
        toast({ title: "Failed to create opportunity", description: body.error ?? "Unknown error", variant: "destructive" });
        return;
      }
      toast({ title: "Opportunity created", description: "Ready to generate a proposal." });
      setLocation(`/proposals?opportunity=${body.id ?? ""}`);
    } finally {
      setCreatingOpportunity(false);
    }
  };

  const handleIntakeSubmit = (values: IntakeValues) => {
    const brief = formatBrief(values);
    setBriefText(brief);

    parseBrief.mutate(
      { data: { briefText: brief } },
      {
        onSuccess: (data) => {
          form.setValue("clientName", data.clientName);
          form.setValue("industry", data.industry);
          form.setValue("proposalContent", data.proposalContent);
          setStep(2);
        },
        onError: (error) => {
          toast({
            title: "Generation failed",
            description: (error as { error?: string }).error || "An unexpected error occurred.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleSave = (values: ProposalFormValues) => {
    createProposal.mutate(
      { data: { briefText, ...values } },
      {
        onSuccess: (proposal) => {
          queryClient.invalidateQueries({ queryKey: getListProposalsQueryKey() });
          toast({ title: "Saved", description: "Proposal saved successfully." });
          setLocation(`/proposals/${proposal.id}`);
        },
        onError: (error) => {
          toast({
            title: "Save failed",
            description: (error as { error?: string }).error || "Could not save proposal.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleExport = async (values: ProposalFormValues) => {
    setIsExporting(true);
    createProposal.mutate(
      { data: { briefText, ...values } },
      {
        onSuccess: (proposal) => {
          queryClient.invalidateQueries({ queryKey: getListProposalsQueryKey() });
          exportToDocs.mutate(
            { id: proposal.id },
            {
              onSuccess: (data) => {
                toast({
                  title: "Exported successfully",
                  description: (
                    <div className="flex flex-col gap-2 mt-2">
                      <p>Document created in Google Docs.</p>
                      <Button variant="outline" size="sm" asChild className="w-fit">
                        <a
                          href={data.docUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-2"
                        >
                          <ExternalLink className="w-4 h-4" />
                          Open Document
                        </a>
                      </Button>
                    </div>
                  ),
                  duration: 10000,
                });
                setLocation(`/proposals/${proposal.id}`);
              },
              onError: (error) => {
                toast({
                  title: "Export failed",
                  description: (error as { error?: string }).error || "Could not export to Google Docs.",
                  variant: "destructive",
                });
              },
              onSettled: () => setIsExporting(false),
            },
          );
        },
        onError: (error) => {
          setIsExporting(false);
          toast({
            title: "Save failed before export",
            description: (error as { error?: string }).error || "Could not save proposal.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const objectivesValue = intake.watch("objectives");
  const servicesValue = intake.watch("services");

  return (
    <div className="p-8 max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-4xl font-bold text-white mb-2 tracking-tight">
          New Proposal
        </h1>
        <div className="flex items-center gap-4 text-sm font-medium">
          <span className={step === 1 ? "text-primary" : "text-muted-foreground"}>
            1. Project Brief
          </span>
          <span className="text-muted-foreground">→</span>
          <span className={step === 2 ? "text-primary" : "text-muted-foreground"}>
            2. Review & Export
          </span>
        </div>
      </div>

      {/* ── Step 1: generating (progress bar) ── */}
      {step === 1 && parseBrief.isPending && (
        <div className="bg-card border rounded-lg p-10 flex flex-col items-center justify-center gap-6 min-h-[400px]">
          <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center">
            <FileText className="w-6 h-6 text-primary" />
          </div>
          <div className="text-center space-y-1">
            <p className="text-lg font-semibold text-foreground">Generating your proposal</p>
            <p className="text-sm text-muted-foreground">
              {STATUS_MESSAGES[Math.min(
                Math.floor((genProgress / 95) * STATUS_MESSAGES.length),
                STATUS_MESSAGES.length - 1,
              )]}
            </p>
          </div>
          <div className="w-full max-w-md space-y-2">
            <Progress value={genProgress} className="h-2" />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{Math.round(genProgress)}%</span>
              <span>
                {genProgress < 95
                  ? `~${Math.max(1, Math.round(ESTIMATED_SECONDS - (genProgress / 95) * ESTIMATED_SECONDS))}s remaining`
                  : "Almost done…"}
              </span>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            The AI is writing a full 15-section proposal — this usually takes about 45–60 seconds.
          </p>
        </div>
      )}

      {/* ── Step 1: blank mode → skip straight to proposal form ── */}
      {step === 1 && !parseBrief.isPending && mode === "blank" && (
        <div className="bg-card border rounded-lg p-10 flex flex-col items-center justify-center gap-6 min-h-[300px]">
          <FileText className="w-12 h-12 text-muted-foreground" />
          <div className="text-center space-y-1">
            <p className="text-lg font-semibold text-foreground">Start with a blank proposal</p>
            <p className="text-sm text-muted-foreground">Fill in the details yourself — no AI parsing needed.</p>
          </div>
          <Button size="lg" onClick={() => setStep(2)}>Start Blank Proposal</Button>
        </div>
      )}

      {/* ── Step 1: manual mode → redirect to Opportunities ── */}
      {step === 1 && !parseBrief.isPending && mode === "manual" && (
        <div className="bg-card border rounded-lg p-10 flex flex-col items-center justify-center gap-6 min-h-[300px]">
          <ClipboardList className="w-12 h-12 text-muted-foreground" />
          <div className="text-center space-y-1">
            <p className="text-lg font-semibold text-foreground">Create a Manual Opportunity</p>
            <p className="text-sm text-muted-foreground">Add an opportunity manually then pursue it to generate a proposal.</p>
          </div>
          <Button size="lg" onClick={() => setLocation("/opportunities?add=1")}>Go to Opportunities</Button>
        </div>
      )}

      {/* ── Step 1: mode toggle + content ── */}
      {step === 1 && !parseBrief.isPending && (mode === "form" || mode === "paste" || mode === "import") && (
        <>
          {/* Mode toggle */}
          <div className="flex rounded-lg border border-border overflow-hidden w-fit mb-6">
            <button
              type="button"
              onClick={() => setMode("form")}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium transition-colors ${
                mode === "form" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-accent"
              }`}
            >
              <ClipboardList className="w-4 h-4" />
              Guided Form
            </button>
            <button
              type="button"
              onClick={() => setMode("paste")}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium transition-colors ${
                mode === "paste" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-accent"
              }`}
            >
              <FileText className="w-4 h-4" />
              Paste Text
            </button>
            <button
              type="button"
              onClick={() => setMode("import")}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium transition-colors ${
                mode === "import" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-accent"
              }`}
            >
              <UploadCloud className="w-4 h-4" />
              Import File / URL
            </button>
          </div>

          {/* ── Import (file / URL) panel → creates canonical Opportunity ── */}
          {mode === "import" && (
            <div className="space-y-4">
              <div className="bg-card border rounded-lg overflow-hidden">
                <div className="bg-muted px-6 py-4 border-b">
                  <h2 className="font-semibold text-foreground">Import RFP</h2>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    Upload a file or enter a URL — a new Opportunity will be created for review and pursuit.
                  </p>
                </div>
                <div className="p-6 space-y-4">
                  {/* File upload zone */}
                  <div
                    className="border-2 border-dashed border-border rounded-lg p-6 flex flex-col items-center gap-3 cursor-pointer hover:border-primary/50 transition-colors"
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const f = e.dataTransfer.files[0];
                      if (f) handleFileSelect(f);
                    }}
                  >
                    {pasteFileExtracting ? (
                      <>
                        <Loader2 className="w-8 h-8 text-muted-foreground animate-spin" />
                        <p className="text-sm text-muted-foreground">Reading document…</p>
                      </>
                    ) : pasteFile ? (
                      <div className="flex items-center gap-3 w-full">
                        <FileText className="w-5 h-5 text-primary shrink-0" />
                        <span className="text-sm text-foreground flex-1 truncate">{pasteFile.name}</span>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setPasteFile(null); setPasteText(""); if (fileInputRef.current) fileInputRef.current.value = ""; }}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <UploadCloud className="w-8 h-8 text-muted-foreground" />
                        <div className="text-center">
                          <p className="text-sm font-medium text-foreground">Drop a file or click to browse</p>
                          <p className="text-xs text-muted-foreground mt-0.5">PDF, DOCX, TXT · Max 20 MB</p>
                        </div>
                      </>
                    )}
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf,.docx,.txt"
                    className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileSelect(f); }}
                  />
                  {pasteFileError && <p className="text-xs text-destructive">{pasteFileError}</p>}

                  {/* Divider */}
                  <div className="flex items-center gap-3">
                    <div className="flex-1 border-t border-border" />
                    <span className="text-xs text-muted-foreground">or enter a URL</span>
                    <div className="flex-1 border-t border-border" />
                  </div>

                  {/* URL input */}
                  <Input
                    type="url"
                    placeholder="https://example.gov/rfp/2026-tender.pdf"
                    value={importUrl}
                    onChange={(e) => setImportUrl(e.target.value)}
                  />

                  <div className="flex items-center justify-between">
                    <div>
                      {pasteError && <p className="text-xs text-destructive">{pasteError}</p>}
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex justify-end">
                <Button type="button" size="lg" className="gap-2" onClick={() => void handleImportAsOpportunity()} disabled={creatingOpportunity}>
                  {creatingOpportunity ? <Loader2 className="w-4 h-4 animate-spin" /> : <UploadCloud className="w-4 h-4" />}
                  {creatingOpportunity ? "Creating Opportunity…" : "Create Opportunity"}
                </Button>
              </div>
            </div>
          )}

          {/* ── Paste / Upload panel → creates canonical Opportunity ── */}
          {mode === "paste" && (
            <div className="space-y-4">
              <div className="bg-card border rounded-lg overflow-hidden">
                <div className="bg-muted px-6 py-4 border-b">
                  <h2 className="font-semibold text-foreground">Project Brief</h2>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    Paste a brief, RFP, or any document — the AI will read it and generate a full proposal.
                  </p>
                </div>
                <div className="p-6 space-y-4">
                  {/* File upload zone */}
                  <div
                    className="border-2 border-dashed border-border rounded-lg p-6 flex flex-col items-center gap-3 cursor-pointer hover:border-primary/50 transition-colors"
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const f = e.dataTransfer.files[0];
                      if (f) handleFileSelect(f);
                    }}
                  >
                    {pasteFileExtracting ? (
                      <>
                        <Loader2 className="w-8 h-8 text-muted-foreground animate-spin" />
                        <p className="text-sm text-muted-foreground">Reading document…</p>
                      </>
                    ) : pasteFile ? (
                      <div className="flex items-center gap-3 w-full">
                        <FileText className="w-5 h-5 text-primary shrink-0" />
                        <span className="text-sm text-foreground flex-1 truncate">{pasteFile.name}</span>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setPasteFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <UploadCloud className="w-8 h-8 text-muted-foreground" />
                        <div className="text-center">
                          <p className="text-sm font-medium text-foreground">Drop a file or click to browse</p>
                          <p className="text-xs text-muted-foreground mt-0.5">PDF, DOCX, TXT · Max 20 MB</p>
                        </div>
                      </>
                    )}
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf,.docx,.txt"
                    className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileSelect(f); }}
                  />
                  {pasteFileError && <p className="text-xs text-destructive">{pasteFileError}</p>}

                  {/* Divider */}
                  <div className="flex items-center gap-3">
                    <div className="flex-1 border-t border-border" />
                    <span className="text-xs text-muted-foreground">or paste text below</span>
                    <div className="flex-1 border-t border-border" />
                  </div>

                  {/* RFP sources helper */}
                  <div className="rounded-md border border-border bg-muted/30">
                    <button
                      type="button"
                      className="w-full flex items-center justify-between px-4 py-2.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                      onClick={() => setShowRfpSources((v) => !v)}
                    >
                      <span className="font-medium">Where to find RFPs to paste</span>
                      <ChevronDown className={`w-4 h-4 transition-transform ${showRfpSources ? "rotate-180" : ""}`} />
                    </button>

                    {showRfpSources && (
                      <div className="px-4 pb-4 space-y-4 border-t border-border pt-3">
                        {/* Blocked — manual only */}
                        <div>
                          <p className="text-xs font-semibold text-amber-400 uppercase tracking-wide mb-2">Browse manually — not auto-crawled</p>
                          <div className="space-y-1.5">
                            {([
                              { name: "IDB",            label: "Inter-American Development Bank", url: "https://www.iadb.org/en/projects/all?query=communications+marketing&country=BS,JM,TT,BB,GY,LC,VC" },
                              { name: "CDB",            label: "Caribbean Development Bank",       url: "https://www.caribank.org/news-and-events" },
                              { name: "CTO",            label: "Caribbean Tourism Organisation",   url: "https://www.caribtourism.com/procurement" },
                              { name: "CARIFORUM",      label: "EU–Caribbean forum",               url: "https://www.cariforum.org/tenders" },
                              { name: "EU LAC Found.",  label: "EU–Latin America & Caribbean",     url: "https://eulacfoundation.org/en/calls" },
                              { name: "TED Europa",     label: "EU tenders (global)",               url: "https://ted.europa.eu/en/search?scope=ACTIVE&query=caribbean+communications" },
                            ] as const).map(({ name, label, url }) => (
                              <a
                                key={name}
                                href={url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-3 rounded px-2 py-1.5 hover:bg-muted transition-colors group"
                              >
                                <span className="text-xs font-mono font-semibold text-foreground w-24 shrink-0">{name}</span>
                                <span className="text-xs text-muted-foreground flex-1 truncate">{label}</span>
                                <ExternalLink className="w-3 h-3 text-muted-foreground group-hover:text-foreground shrink-0" />
                              </a>
                            ))}
                          </div>
                        </div>

                        {/* Auto-crawled — supplementary */}
                        <div>
                          <p className="text-xs font-semibold text-emerald-500 uppercase tracking-wide mb-2">Already auto-crawled → check Discover first</p>
                          <div className="space-y-1.5">
                            {([
                              { name: "World Bank",   label: "Procurement notices",           url: "https://projects.worldbank.org/en/projects-operations/procurement" },
                              { name: "UNDP",         label: "UN procurement notices",        url: "https://procurement-notices.undp.org/" },
                              { name: "CARICOM",      label: "Caribbean Community notices",   url: "https://caricom.org/" },
                              { name: "Bahamas Gov",  label: "Official tender notices",       url: "https://www.bahamas.gov.bs/tender-notices" },
                            ] as const).map(({ name, label, url }) => (
                              <a
                                key={name}
                                href={url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-3 rounded px-2 py-1.5 hover:bg-muted transition-colors group"
                              >
                                <span className="text-xs font-mono font-semibold text-foreground w-24 shrink-0">{name}</span>
                                <span className="text-xs text-muted-foreground flex-1 truncate">{label}</span>
                                <ExternalLink className="w-3 h-3 text-muted-foreground group-hover:text-foreground shrink-0" />
                              </a>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Textarea */}
                  <Textarea
                    rows={14}
                    placeholder="Paste your brief, RFP, meeting notes, or any project context here…"
                    className="resize-y font-mono text-sm"
                    value={pasteText}
                    onChange={(e) => setPasteText(e.target.value)}
                  />
                  {/* Completeness check result */}
                  {briefChecking && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Checking brief…
                    </div>
                  )}
                  {!briefChecking && briefCheck && (
                    <div className={`rounded-md border px-4 py-3 text-sm ${briefCheck.sufficient ? "border-emerald-600/40 bg-emerald-950/30" : "border-amber-600/40 bg-amber-950/30"}`}>
                      <div className="flex items-start gap-2">
                        {briefCheck.sufficient ? (
                          <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
                        ) : (
                          <span className="text-amber-400 mt-0.5 shrink-0 text-base leading-none">⚠</span>
                        )}
                        <div className="flex-1">
                          <p className={`font-medium ${briefCheck.sufficient ? "text-emerald-300" : "text-amber-300"}`}>
                            {briefCheck.sufficient ? "Brief looks good" : "Brief may be thin"}
                          </p>
                          <p className="text-muted-foreground mt-0.5">{briefCheck.summary}</p>
                          {!briefCheck.sufficient && briefCheck.missing.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 mt-2">
                              {briefCheck.missing.map((m) => (
                                <span key={m} className="rounded-full bg-amber-900/50 text-amber-300 border border-amber-700/40 px-2 py-0.5 text-xs capitalize">
                                  {m}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="flex items-center justify-between">
                    <div>
                      {pasteError && <p className="text-xs text-destructive">{pasteError}</p>}
                    </div>
                    <span className="text-xs text-muted-foreground">{pasteText.length} chars</span>
                  </div>
                </div>
              </div>

              <div className="flex justify-end">
                <Button type="button" size="lg" className="gap-2" onClick={() => void handlePasteAsOpportunity()} disabled={creatingOpportunity}>
                  {creatingOpportunity ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
                  {creatingOpportunity ? "Creating Opportunity…" : "Create Opportunity"}
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Step 1: guided intake form ── */}
      {step === 1 && !parseBrief.isPending && mode === "form" && (
        <form
          onSubmit={intake.handleSubmit(handleIntakeSubmit)}
          className="space-y-6"
          noValidate
        >
          {/* Section: About Your Organisation */}
          <div className="bg-card border rounded-lg overflow-hidden">
            <div className="bg-muted px-6 py-4 border-b">
              <h2 className="font-semibold text-foreground">About Your Organisation</h2>
            </div>
            <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-5">
              {/* Org name */}
              <div className="md:col-span-2">
                <Label htmlFor="orgName" className="mb-1.5 block">
                  Organisation Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="orgName"
                  placeholder="e.g. Acme Corporation"
                  {...intake.register("orgName")}
                />
                {intake.formState.errors.orgName && (
                  <p className="text-xs text-destructive mt-1">
                    {intake.formState.errors.orgName.message}
                  </p>
                )}
              </div>

              {/* Website */}
              <div>
                <Label htmlFor="website" className="mb-1.5 block">
                  Website <span className="text-muted-foreground text-xs">(optional)</span>
                </Label>
                <Input
                  id="website"
                  placeholder="https://yourwebsite.com"
                  {...intake.register("website")}
                />
              </div>

              {/* Industry */}
              <div>
                <Label htmlFor="industry" className="mb-1.5 block">
                  Industry / Service Category <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="industry"
                  placeholder="e.g. Technology, Healthcare, Retail"
                  {...intake.register("industry")}
                />
                {intake.formState.errors.industry && (
                  <p className="text-xs text-destructive mt-1">
                    {intake.formState.errors.industry.message}
                  </p>
                )}
              </div>

              {/* Years operating */}
              <div className="md:col-span-2">
                <Label className="mb-1.5 block">
                  How long has your organisation been operating? <span className="text-destructive">*</span>
                </Label>
                <div className="flex flex-wrap gap-2">
                  {YEARS_OPTIONS.map((opt) => (
                    <label
                      key={opt}
                      className={`flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm cursor-pointer transition-colors
                        ${intake.watch("yearsOperating") === opt
                          ? "border-primary bg-primary/10 text-primary font-medium"
                          : "border-border hover:border-primary/40"}`}
                    >
                      <input
                        type="radio"
                        className="sr-only"
                        value={opt}
                        {...intake.register("yearsOperating")}
                      />
                      {opt}
                    </label>
                  ))}
                </div>
                {intake.formState.errors.yearsOperating && (
                  <p className="text-xs text-destructive mt-1">
                    {intake.formState.errors.yearsOperating.message}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Section: Marketing Objectives */}
          <div className="bg-card border rounded-lg overflow-hidden">
            <div className="bg-muted px-6 py-4 border-b">
              <h2 className="font-semibold text-foreground">Marketing Objectives</h2>
              <p className="text-sm text-muted-foreground mt-0.5">
                What are your primary marketing objectives? Select all that apply.
              </p>
            </div>
            <div className="p-6 space-y-4">
              <Controller
                control={intake.control}
                name="objectives"
                render={({ field }) => (
                  <CheckboxGroup
                    options={OBJECTIVE_OPTIONS}
                    value={field.value}
                    onChange={field.onChange}
                  />
                )}
              />
              {intake.formState.errors.objectives && (
                <p className="text-xs text-destructive">
                  {intake.formState.errors.objectives.message}
                </p>
              )}
              {objectivesValue.includes("Other") && (
                <div>
                  <Label className="mb-1.5 block text-sm">Please specify</Label>
                  <Input
                    placeholder="Describe your objective..."
                    {...intake.register("objectivesOther")}
                  />
                </div>
              )}
            </div>
          </div>

          {/* Section: Services & Support */}
          <div className="bg-card border rounded-lg overflow-hidden">
            <div className="bg-muted px-6 py-4 border-b">
              <h2 className="font-semibold text-foreground">Services & Support</h2>
              <p className="text-sm text-muted-foreground mt-0.5">
                What marketing services are you interested in? Select all that apply.
              </p>
            </div>
            <div className="p-6 space-y-4">
              <Controller
                control={intake.control}
                name="services"
                render={({ field }) => (
                  <CheckboxGroup
                    options={SERVICE_OPTIONS}
                    value={field.value}
                    onChange={field.onChange}
                  />
                )}
              />
              {intake.formState.errors.services && (
                <p className="text-xs text-destructive">
                  {intake.formState.errors.services.message}
                </p>
              )}
              {servicesValue.includes("Other") && (
                <div>
                  <Label className="mb-1.5 block text-sm">Please specify</Label>
                  <Input
                    placeholder="Describe the service..."
                    {...intake.register("servicesOther")}
                  />
                </div>
              )}
            </div>
          </div>

          {/* Section: Challenges & Goals */}
          <div className="bg-card border rounded-lg overflow-hidden">
            <div className="bg-muted px-6 py-4 border-b">
              <h2 className="font-semibold text-foreground">Challenges & Goals</h2>
            </div>
            <div className="p-6 grid grid-cols-1 gap-5">
              <div>
                <Label htmlFor="challenges" className="mb-1.5 block">
                  What marketing challenges are you facing? <span className="text-destructive">*</span>
                </Label>
                <Textarea
                  id="challenges"
                  rows={4}
                  placeholder="Describe the main challenges you'd like help solving..."
                  {...intake.register("challenges")}
                />
                {intake.formState.errors.challenges && (
                  <p className="text-xs text-destructive mt-1">
                    {intake.formState.errors.challenges.message}
                  </p>
                )}
              </div>
              <div>
                <Label htmlFor="successCriteria" className="mb-1.5 block">
                  What would a successful outcome look like? <span className="text-destructive">*</span>
                </Label>
                <Textarea
                  id="successCriteria"
                  rows={4}
                  placeholder="Describe what success looks like for this engagement..."
                  {...intake.register("successCriteria")}
                />
                {intake.formState.errors.successCriteria && (
                  <p className="text-xs text-destructive mt-1">
                    {intake.formState.errors.successCriteria.message}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Section: Timing */}
          <div className="bg-card border rounded-lg overflow-hidden">
            <div className="bg-muted px-6 py-4 border-b">
              <h2 className="font-semibold text-foreground">Timing</h2>
            </div>
            <div className="p-6">
              <Label className="mb-1.5 block">
                When would you ideally like to start? <span className="text-destructive">*</span>
              </Label>
              <div className="flex flex-wrap gap-2">
                {START_OPTIONS.map((opt) => (
                  <label
                    key={opt}
                    className={`flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm cursor-pointer transition-colors
                      ${intake.watch("idealStart") === opt
                        ? "border-primary bg-primary/10 text-primary font-medium"
                        : "border-border hover:border-primary/40"}`}
                  >
                    <input
                      type="radio"
                      className="sr-only"
                      value={opt}
                      {...intake.register("idealStart")}
                    />
                    {opt}
                  </label>
                ))}
              </div>
              {intake.formState.errors.idealStart && (
                <p className="text-xs text-destructive mt-1">
                  {intake.formState.errors.idealStart.message}
                </p>
              )}
            </div>
          </div>

          {/* Submit */}
          <div className="flex justify-end pt-2">
            <Button type="submit" size="lg" className="gap-2">
              <FileText className="w-4 h-4" />
              Generate Proposal
            </Button>
          </div>
        </form>
      )}

      {/* ── Step 2: proposal editor ── */}
      {step === 2 && (
        <Form {...form}>
          <form className="space-y-6" onSubmit={(e) => e.preventDefault()}>
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
                          className="min-h-[600px] p-8 font-sans text-base leading-relaxed prose prose-sm max-w-none
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

            <div className="flex justify-end gap-4 pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => setStep(1)}
              >
                Back
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={createProposal.isPending || isExporting}
                onClick={() => form.handleSubmit(handleSave)()}
                data-testid="button-save-draft"
              >
                {createProposal.isPending && !isExporting ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : null}
                Save Draft
              </Button>
              <Button
                type="button"
                disabled={createProposal.isPending || isExporting}
                onClick={() => form.handleSubmit(handleExport)()}
                className="bg-[#0000FF] hover:bg-[#0000FF] text-white border border-[#0000FF]"
                data-testid="button-export"
              >
                {isExporting ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <CheckCircle2 className="w-4 h-4 mr-2" />
                )}
                Export to Google Docs
              </Button>
            </div>
          </form>
        </Form>
      )}
    </div>
  );
}
