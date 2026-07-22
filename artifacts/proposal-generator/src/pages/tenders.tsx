import { useRef, useState } from "react";
import { Link } from "wouter";
import { format } from "date-fns";
import {
  Briefcase,
  Plus,
  Sparkles,
  Upload,
  ChevronRight,
  Trash2,
  Wand2,
  ExternalLink,
} from "lucide-react";
import {
  useListTenders,
  useDeleteTender,
  useCreateTender,
  useImportTendersCsv,
  useExtractTenderFromText,
  getListTendersQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
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
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";

export default function Tenders() {
  const [tab, setTab] = useState<"recommended" | "all">("recommended");
  const recommended = tab === "recommended";
  const { data: tenders, isLoading } = useListTenders({ recommended });
  const deleteTender = useDeleteTender();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this tender?")) return;
    await deleteTender.mutateAsync({ id });
    queryClient.invalidateQueries({ queryKey: getListTendersQueryKey() });
    toast({ title: "Tender deleted" });
  };

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-8 gap-4">
        <div>
          <h1 className="text-4xl font-bold text-white mb-2 tracking-tight">
            Tender Database
          </h1>
          <p className="text-muted-foreground">
            Browse Bahamas marketing tenders and generate proposals with one click.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <ImportCsvDialog />
          <AddTenderDialog />
          <QuickAddDialog />
        </div>
      </div>

      <SourceLinks />

      <Tabs value={tab} onValueChange={(v) => setTab(v as "recommended" | "all")} className="mb-6">
        <TabsList>
          <TabsTrigger value="recommended" data-testid="tab-recommended">
            <Sparkles className="w-4 h-4 mr-1" /> Recommended
          </TabsTrigger>
          <TabsTrigger value="all" data-testid="tab-all">All Tenders</TabsTrigger>
        </TabsList>
      </Tabs>

      {isLoading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 w-full rounded-lg" />
          ))}
        </div>
      ) : !tenders || tenders.length === 0 ? (
        <div className="text-center py-16 px-4 border border-dashed rounded-lg bg-card/50">
          <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
            <Briefcase className="w-6 h-6 text-primary" />
          </div>
          <h3 className="text-lg font-medium text-foreground mb-2">
            {recommended ? "No recommended tenders yet" : "No tenders in the database"}
          </h3>
          <p className="text-muted-foreground mb-6 max-w-sm mx-auto">
            {recommended
              ? "Switch to All Tenders to see everything, or import marketing-relevant tenders to populate recommendations."
              : "Add tenders manually or import a CSV to get started."}
          </p>
        </div>
      ) : (
        <div className="grid gap-4">
          {tenders.map((t) => (
            <div
              key={t.id}
              className="p-6 border bg-card rounded-lg hover:border-primary/50 transition-colors"
              data-testid={`tender-${t.id}`}
            >
              <div className="flex items-start justify-between gap-4">
                <Link
                  href={`/opportunities/${t.id}`}
                  className="flex-1 group cursor-pointer"
                  data-testid={`link-tender-${t.id}`}
                >
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    <h2 className="text-xl font-medium text-foreground group-hover:text-primary transition-colors">
                      {t.title}
                    </h2>
                    <Badge variant="secondary">{t.category}</Badge>
                    {t.recommendationScore > 0 && (
                      <Badge variant="destructive">
                        <Sparkles className="w-3 h-3 mr-1" /> Recommended
                      </Badge>
                    )}
                    {t.proposalId && (
                      <Badge variant="success">Proposal Drafted</Badge>
                    )}
                  </div>
                  <p className="text-sm font-medium text-foreground mb-1">{t.agency}</p>
                  <p className="text-sm text-muted-foreground line-clamp-2 mb-2">{t.description}</p>
                  <div className="flex gap-4 text-xs text-muted-foreground flex-wrap">
                    {t.deadline && (
                      <span>Deadline: {format(new Date(t.deadline), "MMM d, yyyy")}</span>
                    )}
                    {t.valueAmount && <span>Value: {t.valueAmount}</span>}
                    <span>Added {format(new Date(t.createdAt), "MMM d, yyyy")}</span>
                  </div>
                </Link>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleDelete(t.id)}
                    data-testid={`button-delete-${t.id}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                  <Link href={`/opportunities/${t.id}`}>
                    <ChevronRight className="w-5 h-5 text-muted-foreground" />
                  </Link>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AddTenderDialog() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    title: "",
    agency: "",
    description: "",
    category: "Marketing",
    deadline: "",
    valueAmount: "",
    sourceUrl: "",
    contactInfo: "",
  });
  const createTender = useCreateTender();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const submit = async () => {
    if (!form.title || !form.agency || !form.description) {
      toast({ title: "Title, agency, and description are required", variant: "destructive" });
      return;
    }
    await createTender.mutateAsync({
      data: {
        title: form.title,
        agency: form.agency,
        description: form.description,
        category: form.category || "General",
        deadline: form.deadline ? new Date(form.deadline) : null,
        valueAmount: form.valueAmount || null,
        sourceUrl: form.sourceUrl || null,
        contactInfo: form.contactInfo || null,
      },
    });
    queryClient.invalidateQueries({ queryKey: getListTendersQueryKey() });
    toast({ title: "Tender added" });
    setOpen(false);
    setForm({
      title: "",
      agency: "",
      description: "",
      category: "Marketing",
      deadline: "",
      valueAmount: "",
      sourceUrl: "",
      contactInfo: "",
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button data-testid="button-add-tender">
          <Plus className="w-4 h-4 mr-1" /> Add Tender
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Tender</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div>
            <Label>Title *</Label>
            <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </div>
          <div>
            <Label>Issuing Agency *</Label>
            <Input value={form.agency} onChange={(e) => setForm({ ...form, agency: e.target.value })} />
          </div>
          <div>
            <Label>Description / Scope *</Label>
            <Textarea
              rows={5}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Category</Label>
              <Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
            </div>
            <div>
              <Label>Deadline</Label>
              <Input
                type="date"
                value={form.deadline}
                onChange={(e) => setForm({ ...form, deadline: e.target.value })}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Estimated Value</Label>
              <Input
                placeholder="e.g. BSD 250,000"
                value={form.valueAmount}
                onChange={(e) => setForm({ ...form, valueAmount: e.target.value })}
              />
            </div>
            <div>
              <Label>Source URL</Label>
              <Input
                value={form.sourceUrl}
                onChange={(e) => setForm({ ...form, sourceUrl: e.target.value })}
              />
            </div>
          </div>
          <div>
            <Label>Contact Info</Label>
            <Input
              value={form.contactInfo}
              onChange={(e) => setForm({ ...form, contactInfo: e.target.value })}
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={createTender.isPending}>
            {createTender.isPending ? "Saving..." : "Add Tender"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const TENDER_SOURCES = [
  { name: "Bahamas Gov Tenders", url: "https://www.bahamas.gov.bs/tender-notices" },
  { name: "Bahamas Bonfire Hub", url: "https://bahamas.bonfirehub.com" },
  { name: "UN Global Marketplace", url: "https://www.ungm.org" },
  { name: "DG Market", url: "https://www.dgmarket.com/" },
];

function SourceLinks() {
  return (
    <div className="mb-6 p-4 border rounded-lg bg-card/50">
      <p className="text-xs uppercase text-muted-foreground mb-2 font-medium">
        Browse Tender Sources
      </p>
      <div className="flex flex-wrap gap-2">
        {TENDER_SOURCES.map((s) => (
          <a
            key={s.url}
            href={s.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm px-3 py-1.5 border rounded-md hover:bg-muted transition-colors"
            data-testid={`source-${s.name.toLowerCase().replace(/\s+/g, "-")}`}
          >
            {s.name} <ExternalLink className="w-3 h-3" />
          </a>
        ))}
      </div>
      <p className="text-xs text-muted-foreground mt-2">
        Open a source, copy a tender posting, then click <strong>Quick Add</strong> to extract it
        with AI.
      </p>
    </div>
  );
}

function QuickAddDialog() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const extract = useExtractTenderFromText();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleFile = async (file: File) => {
    const MAX = 45 * 1024 * 1024; // keep below server's 50MB cap
    if (file.size > MAX) {
      toast({
        title: "File too large",
        description: `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB. Max is 45 MB. Try saving the PDF with reduced quality, or paste the text instead.`,
        variant: "destructive",
      });
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${import.meta.env.BASE_URL}api/extract-text`, {
        method: "POST",
        body: fd,
      });
      // Server may return HTML (e.g. 413 from upstream proxy) — read as text first.
      const raw = await res.text();
      let data: any = {};
      try {
        data = JSON.parse(raw);
      } catch {
        data = { error: res.status === 413 ? "File too large for the server to accept." : `Server returned ${res.status}` };
      }
      if (!res.ok) throw new Error(data?.error || "Failed to read file");
      setText((prev) => (prev ? prev + "\n\n" : "") + (data.text ?? ""));
      toast({
        title: `Loaded ${file.name}`,
        description: "Review the extracted text, then click Extract & Add.",
      });
    } catch (e: any) {
      toast({
        title: "Could not read file",
        description: e?.message ?? String(e),
        variant: "destructive",
      });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const submit = async () => {
    if (text.trim().length < 30) {
      toast({
        title: "Paste a longer tender description",
        description: "AI needs at least a paragraph to extract tender details.",
        variant: "destructive",
      });
      return;
    }
    try {
      await extract.mutateAsync({
        data: { text, sourceUrl: sourceUrl.trim() || null },
      });
      queryClient.invalidateQueries({ queryKey: getListTendersQueryKey() });
      toast({ title: "Tender extracted and added" });
      setOpen(false);
      setText("");
      setSourceUrl("");
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      toast({ title: "Could not extract tender", description: msg, variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button data-testid="button-quick-add">
          <Wand2 className="w-4 h-4 mr-1" /> Quick Add (Paste)
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Quick Add Tender</DialogTitle>
        </DialogHeader>
        <div className="py-4 space-y-4">
          <p className="text-sm text-muted-foreground">
            Upload a tender PDF (or .docx / .txt) — or paste the text directly from any source
            (bahamas.gov.bs, Bonfire, UNGM, DG Market, email, anywhere). AI will extract the
            title, agency, scope, deadline, value, and contact info, then add it to your
            database.
          </p>
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
              data-testid="input-tender-file"
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              data-testid="button-upload-tender-pdf"
            >
              {uploading ? (
                <>Reading file...</>
              ) : (
                <>
                  <Upload className="w-4 h-4 mr-2" /> Upload PDF / DOCX
                </>
              )}
            </Button>
          </div>
          <div>
            <Label>Source URL (optional)</Label>
            <Input
              placeholder="https://bahamas.bonfirehub.com/portal/?tab=openOpportunities&id=..."
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
            />
          </div>
          <div>
            <Label>Pasted tender text *</Label>
            <Textarea
              rows={14}
              placeholder="Paste the tender description here..."
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={extract.isPending}>
            {extract.isPending ? (
              <>Extracting with AI...</>
            ) : (
              <>
                <Wand2 className="w-4 h-4 mr-1" /> Extract & Add
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportCsvDialog() {
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState("");
  const importCsv = useImportTendersCsv();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const submit = async () => {
    if (!csv.trim()) {
      toast({ title: "Paste CSV content first", variant: "destructive" });
      return;
    }
    try {
      const result = await importCsv.mutateAsync({ data: { csv } });
      queryClient.invalidateQueries({ queryKey: getListTendersQueryKey() });
      toast({
        title: `Imported ${result.imported} tenders`,
        description: result.skipped > 0 ? `${result.skipped} rows skipped` : undefined,
      });
      setOpen(false);
      setCsv("");
    } catch (e) {
      toast({ title: "Import failed", description: String(e), variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" data-testid="button-import-csv">
          <Upload className="w-4 h-4 mr-1" /> Import CSV
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import Tenders from CSV</DialogTitle>
        </DialogHeader>
        <div className="py-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            Paste CSV with header row. Required columns: <code>title</code>, <code>agency</code>,{" "}
            <code>description</code>. Optional: <code>category</code>, <code>deadline</code>,{" "}
            <code>value_amount</code>, <code>source_url</code>, <code>contact_info</code>.
          </p>
          <Textarea
            rows={12}
            placeholder={`title,agency,description,category,deadline,value_amount\n"Tourism Marketing Campaign","Bahamas Ministry of Tourism","Develop and execute a 12-month digital marketing campaign...","Marketing","2026-06-15","BSD 500,000"`}
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            className="font-mono text-xs"
          />
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={importCsv.isPending}>
            {importCsv.isPending ? "Importing..." : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
