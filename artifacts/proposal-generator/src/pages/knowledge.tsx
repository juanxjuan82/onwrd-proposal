import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BookOpen, CheckCircle2, Plus, Upload, Trash2, Clock, RefreshCw } from "lucide-react";
import { format } from "date-fns";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const DOC_TYPES = [
  { value: "case_study", label: "Case Study" },
  { value: "capability", label: "Capability" },
  { value: "snippet", label: "Snippet" },
  { value: "bio", label: "Team Bio" },
  { value: "credential", label: "Credential" },
];

interface KnowledgeDoc {
  id: number;
  title: string;
  content: string;
  docType: string;
  isApproved: boolean;
  sourceUrl?: string | null;
  tags: string;
  createdAt: string;
  updatedAt: string;
}

function useKnowledge() {
  return useQuery<KnowledgeDoc[]>({
    queryKey: ["knowledge"],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/knowledge`);
      if (!r.ok) throw new Error("Failed to load knowledge library");
      return r.json();
    },
  });
}

function docTypeLabel(type: string) {
  return DOC_TYPES.find((d) => d.value === type)?.label ?? type;
}

function docTypeBadge(type: string) {
  const colors: Record<string, string> = {
    case_study: "bg-blue-900/20 text-blue-300 border-blue-900",
    capability: "bg-purple-900/20 text-purple-300 border-purple-900",
    snippet: "bg-gray-800 text-gray-300 border-gray-700",
    bio: "bg-green-900/20 text-green-300 border-green-900",
    credential: "bg-yellow-900/20 text-yellow-300 border-yellow-900",
  };
  return colors[type] ?? "bg-muted text-muted-foreground border-border";
}

export default function Knowledge() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: docs, isLoading } = useKnowledge();
  const [showCreate, setShowCreate] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<KnowledgeDoc | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState<string>("all");

  const [form, setForm] = useState({
    title: "",
    content: "",
    docType: "capability",
  });

  const createDoc = useMutation({
    mutationFn: async (body: { title: string; content: string; docType: string }) => {
      const r = await fetch(`${BASE}/api/knowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error((e as { error?: string }).error ?? "Failed to create document");
      }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["knowledge"] });
      toast({ title: "Document created", description: "Approve it for reuse in proposal generation." });
      setShowCreate(false);
      setForm({ title: "", content: "", docType: "capability" });
    },
    onError: (err) => toast({ title: "Create failed", description: (err as Error).message, variant: "destructive" }),
  });

  const importFile = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("docType", "capability");
      const r = await fetch(`${BASE}/api/knowledge/import-file`, { method: "POST", body: fd });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error((e as { error?: string }).error ?? "Import failed");
      }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["knowledge"] });
      toast({ title: "File imported", description: "Review and approve the document for reuse." });
    },
    onError: (err) => toast({ title: "Import failed", description: (err as Error).message, variant: "destructive" }),
  });

  const approveDoc = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${BASE}/api/knowledge/${id}/approve-for-reuse`, { method: "POST" });
      if (!r.ok) throw new Error("Failed to approve");
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["knowledge"] });
      toast({ title: "Approved for reuse" });
    },
    onError: (err) => toast({ title: "Approve failed", description: (err as Error).message, variant: "destructive" }),
  });

  const deleteDoc = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`${BASE}/api/knowledge/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error("Failed to delete");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["knowledge"] });
      setSelectedDoc(null);
      toast({ title: "Document deleted" });
    },
    onError: (err) => toast({ title: "Delete failed", description: (err as Error).message, variant: "destructive" }),
  });

  const crawlBios = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${BASE}/api/knowledge/crawl-bios`, { method: "POST" });
      const data = await r.json();
      if (!r.ok) throw new Error((data as { error?: string }).error ?? "Crawl failed");
      return data as { created: number; updated: number };
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["knowledge"] });
      const msg = data.created ? `${data.created} imported` : "Already up to date";
      toast({ title: "Team bios synced", description: msg });
    },
    onError: (err) => toast({ title: "Sync failed", description: (err as Error).message, variant: "destructive" }),
  });

  const crawlCaseStudies = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${BASE}/api/knowledge/crawl-case-studies`, { method: "POST" });
      const data = await r.json();
      if (!r.ok) throw new Error((data as { error?: string }).error ?? "Crawl failed");
      return data as { created: number; updated: number; failed: number; total: number };
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["knowledge"] });
      toast({
        title: `Synced ${data.total} case studies`,
        description: `${data.created} new · ${data.updated} updated · ${data.failed} failed`,
      });
    },
    onError: (err) => toast({ title: "Sync failed", description: (err as Error).message, variant: "destructive" }),
  });

  const filtered = (docs ?? []).filter((d) => filter === "all" || d.docType === filter);

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-8 gap-4">
        <div>
          <h1 className="text-4xl font-bold text-white mb-2 tracking-tight">Knowledge Library</h1>
          <p className="text-muted-foreground">Case studies, capabilities, and snippets used to ground AI proposal generation.</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" onClick={() => crawlBios.mutate()} disabled={crawlBios.isPending}>
            <RefreshCw className={`w-4 h-4 mr-2 ${crawlBios.isPending ? "animate-spin" : ""}`} />
            {crawlBios.isPending ? "Syncing…" : "Sync Team Bios"}
          </Button>
          <Button variant="outline" onClick={() => crawlCaseStudies.mutate()} disabled={crawlCaseStudies.isPending}>
            <RefreshCw className={`w-4 h-4 mr-2 ${crawlCaseStudies.isPending ? "animate-spin" : ""}`} />
            {crawlCaseStudies.isPending ? "Syncing…" : "Sync Case Studies"}
          </Button>
          <Button variant="outline" onClick={() => fileInputRef.current?.click()} disabled={importFile.isPending}>
            <Upload className="w-4 h-4 mr-2" />
            {importFile.isPending ? "Importing…" : "Import File"}
          </Button>
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="w-4 h-4 mr-2" />
            Add Document
          </Button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.docx,.txt"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) importFile.mutate(file);
            e.target.value = "";
          }}
        />
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2 mb-6 flex-wrap">
        {[{ value: "all", label: "All" }, ...DOC_TYPES].map((t) => (
          <button
            key={t.value}
            onClick={() => setFilter(t.value)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
              filter === t.value
                ? "bg-primary text-white border-primary"
                : "bg-card text-muted-foreground border-border hover:text-white"
            }`}
          >
            {t.label}
          </button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground self-center">
          {(docs ?? []).filter((d) => d.isApproved).length} approved for reuse
        </span>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full rounded-lg" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 px-4 border border-dashed rounded-lg bg-card/50">
          <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
            <BookOpen className="w-6 h-6 text-primary" />
          </div>
          <h3 className="text-lg font-medium text-foreground mb-2">No documents yet</h3>
          <p className="text-muted-foreground mb-6 max-w-sm mx-auto">
            Import PDFs, Word docs, or paste content directly to build your knowledge library.
          </p>
          <Button variant="outline" onClick={() => setShowCreate(true)}>Add First Document</Button>
        </div>
      ) : (
        <div className="grid gap-3">
          {filtered.map((doc) => (
            <button
              key={doc.id}
              onClick={() => setSelectedDoc(doc)}
              className="w-full text-left p-4 border bg-card rounded-lg hover:border-primary/50 transition-colors"
            >
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className="text-sm font-medium text-foreground">{doc.title}</span>
                    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${docTypeBadge(doc.docType)}`}>
                      {docTypeLabel(doc.docType)}
                    </span>
                    {doc.isApproved ? (
                      <span className="inline-flex items-center gap-1 text-xs text-green-400">
                        <CheckCircle2 className="w-3 h-3" /> Approved
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock className="w-3 h-3" /> Pending
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-2">
                    {doc.content.substring(0, 180)}{doc.content.length > 180 ? "…" : ""}
                  </p>
                </div>
                <span className="text-xs text-muted-foreground shrink-0 mt-0.5">
                  {format(new Date(doc.createdAt), "MMM d")}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Create Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add Knowledge Document</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1 col-span-2 sm:col-span-1">
                <Label>Title *</Label>
                <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="ONWRD Tourism Campaign Case Study" />
              </div>
              <div className="space-y-1">
                <Label>Type</Label>
                <Select value={form.docType} onValueChange={(v) => setForm({ ...form, docType: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DOC_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label>Content *</Label>
              <Textarea rows={10} value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} placeholder="Paste document content here..." />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={() => createDoc.mutate(form)} disabled={createDoc.isPending}>
              {createDoc.isPending ? "Creating…" : "Create Document"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Detail Dialog */}
      <Dialog open={!!selectedDoc} onOpenChange={(o) => !o && setSelectedDoc(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3 flex-wrap">
              {selectedDoc?.title}
              {selectedDoc && (
                <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${docTypeBadge(selectedDoc.docType)}`}>
                  {docTypeLabel(selectedDoc.docType)}
                </span>
              )}
            </DialogTitle>
          </DialogHeader>
          {selectedDoc && (
            <div className="space-y-4">
              <div className="p-4 rounded-lg bg-muted/30 border text-sm whitespace-pre-wrap leading-relaxed max-h-[50vh] overflow-y-auto">
                {selectedDoc.content}
              </div>
              <div className="flex items-center justify-between gap-3">
                <div className="text-xs text-muted-foreground">
                  Added {format(new Date(selectedDoc.createdAt), "MMM d, yyyy")}
                  {selectedDoc.isApproved ? " · ✓ Approved for reuse" : " · Pending approval"}
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => deleteDoc.mutate(selectedDoc.id)}
                    disabled={deleteDoc.isPending}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                  {!selectedDoc.isApproved && (
                    <Button
                      size="sm"
                      onClick={() => {
                        approveDoc.mutate(selectedDoc.id);
                        setSelectedDoc({ ...selectedDoc, isApproved: true });
                      }}
                      disabled={approveDoc.isPending}
                    >
                      <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />
                      Approve for Reuse
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
