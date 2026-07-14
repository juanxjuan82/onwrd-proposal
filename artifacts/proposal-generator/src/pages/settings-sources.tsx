import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { RefreshCw, Trash2, Play, CheckCircle2, XCircle, Clock, Plus, Mail, Send, AlertTriangle } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

interface TenderSource {
  id: number;
  name: string;
  sourceType: string;
  url: string;
  adapterType: string;
  active: boolean;
  lastCheckedAt?: string | null;
  lastSuccessAt?: string | null;
  itemsFoundCount: number;
}

interface CrawlerRun {
  id: number;
  sourceId: number;
  startedAt: string;
  completedAt?: string | null;
  status: string;
  itemsFound: number;
  itemsNew: number;
  errorMessage?: string | null;
}

interface SearchProfile {
  id: number;
  name: string;
  description: string;
  keywords: string;
  excludedKeywords: string;
  active: boolean;
}

function SourceTypeLabel({ type }: { type: string }) {
  const map: Record<string, string> = {
    government: "Government",
    un: "United Nations",
    development_bank: "Dev Bank",
    ngo: "NGO",
    other: "Other",
  };
  return <span>{map[type] ?? type}</span>;
}

interface DigestSettings {
  id: number;
  emails: string[];
  enabled: boolean;
}

export default function SettingsSources() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState<"sources" | "scoring" | "runs" | "digest">("sources");
  const [newEmail, setNewEmail] = useState("");

  const { data: sources = [], isLoading: sourcesLoading } = useQuery<TenderSource[]>({
    queryKey: ["tender-sources"],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/tender-sources`);
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
  });

  const { data: runs = [] } = useQuery<CrawlerRun[]>({
    queryKey: ["crawler-runs"],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/crawler-runs`);
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    enabled: tab === "runs",
  });

  const { data: profiles = [] } = useQuery<SearchProfile[]>({
    queryKey: ["tender-search-profiles"],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/tender-search-profiles`);
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    enabled: tab === "profiles",
  });

  const toggleSource = useMutation({
    mutationFn: async ({ id, active }: { id: number; active: boolean }) => {
      const r = await fetch(`${BASE}/api/tender-sources/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active }),
      });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tender-sources"] }),
  });

  const deleteSource = useMutation({
    mutationFn: async (id: number) => {
      await fetch(`${BASE}/api/tender-sources/${id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tender-sources"] });
      toast({ title: "Source removed" });
    },
  });

  const crawlSource = useMutation({
    mutationFn: async (sourceId: number) => {
      const r = await fetch(`${BASE}/api/tender-intelligence/crawl`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId }),
      });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "Crawl started", description: "Results will appear in the Inbox in ~1 minute." });
      setTimeout(() => qc.invalidateQueries({ queryKey: ["crawler-runs"] }), 30000);
    },
  });

  const rescore = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${BASE}/api/tender-intelligence/rescore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!r.ok) throw new Error("Failed");
      return r.json() as Promise<{ count: number }>;
    },
    onSuccess: (data) => {
      toast({
        title: "Re-score complete",
        description: `${data.count} items scored using keyword engine. Check the Inbox.`,
      });
      qc.invalidateQueries({ queryKey: ["discovered-tenders"] });
    },
    onError: () => toast({ title: "Re-score failed", variant: "destructive" }),
  });

  const toggleProfile = useMutation({
    mutationFn: async ({ id, active }: { id: number; active: boolean }) => {
      const r = await fetch(`${BASE}/api/tender-search-profiles/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active }),
      });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tender-search-profiles"] }),
  });

  const { data: digest } = useQuery<DigestSettings>({
    queryKey: ["tender-digest-settings"],
    queryFn: async () => {
      const r = await fetch(`${BASE}/api/tender-digest-settings`);
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    enabled: tab === "digest",
  });

  const updateDigest = useMutation({
    mutationFn: async (updates: Partial<DigestSettings>) => {
      const r = await fetch(`${BASE}/api/tender-digest-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tender-digest-settings"] });
      toast({ title: "Saved" });
    },
    onError: () => toast({ title: "Save failed", variant: "destructive" }),
  });

  function addEmail() {
    const email = newEmail.trim().toLowerCase();
    if (!email || !email.includes("@")) return;
    if (digest?.emails.includes(email)) return;
    updateDigest.mutate({ emails: [...(digest?.emails ?? []), email] });
    setNewEmail("");
  }

  function removeEmail(email: string) {
    updateDigest.mutate({ emails: (digest?.emails ?? []).filter((e) => e !== email) });
  }

  const sendTestEmail = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${BASE}/api/tender-digest-settings/test`, { method: "POST" });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Failed");
      return body as { message: string };
    },
    onSuccess: (data) => toast({ title: "Test sent!", description: data.message }),
    onError: (err: Error) => toast({ title: "Send failed", description: err.message, variant: "destructive" }),
  });

  const notifyBilling = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${BASE}/api/tender-intelligence/notify-billing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? "Failed");
      return body as { message: string };
    },
    onSuccess: (data) => toast({ title: "Alert sent", description: data.message }),
    onError: (err: Error) => toast({ title: "Failed to send", description: err.message, variant: "destructive" }),
  });

  const TABS = [
    { value: "sources", label: "Sources" },
    { value: "scoring", label: "Scoring" },
    { value: "digest", label: "Email Digest" },
    { value: "runs", label: "Run History" },
  ] as const;

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="mb-8">
        <h1 className="text-4xl font-bold text-white mb-2 tracking-tight">Tender Intelligence</h1>
        <p className="text-muted-foreground">Manage sources, search profiles, and crawl history.</p>
      </div>

      <div className="flex gap-1 mb-6 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.value}
            onClick={() => setTab(t.value)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === t.value
                ? "border-primary text-white"
                : "border-transparent text-muted-foreground hover:text-white"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "sources" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm text-muted-foreground">{sources.filter((s) => s.active).length} of {sources.length} sources active</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => crawlSource.mutate(undefined as unknown as number)}
              disabled={crawlSource.isPending}
            >
              <Play className="w-3.5 h-3.5 mr-1.5" />
              Run All Now
            </Button>
          </div>

          {sourcesLoading ? (
            [1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full rounded-lg" />)
          ) : (
            sources.map((s) => (
              <div key={s.id} className="flex items-center gap-4 p-4 rounded-lg border border-border bg-card">
                <Switch
                  checked={s.active}
                  onCheckedChange={(active) => toggleSource.mutate({ id: s.id, active })}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="font-medium text-sm text-white">{s.name}</span>
                    <Badge variant="outline" className="text-xs py-0"><SourceTypeLabel type={s.sourceType} /></Badge>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span>{s.itemsFoundCount} found total</span>
                    {s.lastCheckedAt && (
                      <span>· Last checked {formatDistanceToNow(new Date(s.lastCheckedAt), { addSuffix: true })}</span>
                    )}
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => crawlSource.mutate(s.id)}
                    disabled={crawlSource.isPending}
                    title="Run now"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => deleteSource.mutate(s.id)}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {tab === "profiles" && (
        <div className="space-y-3">
          {profiles.map((p) => (
            <div key={p.id} className="p-4 rounded-lg border border-border bg-card">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <Switch
                      checked={p.active}
                      onCheckedChange={(active) => toggleProfile.mutate({ id: p.id, active })}
                    />
                    <span className="font-medium text-sm text-white">{p.name}</span>
                  </div>
                  <p className="text-xs text-muted-foreground mb-2">{p.description}</p>
                  <div className="flex flex-wrap gap-1">
                    {(JSON.parse(p.keywords) as string[]).map((kw) => (
                      <span key={kw} className="px-2 py-0.5 rounded-full bg-primary/10 text-primary text-xs border border-primary/20">{kw}</span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "scoring" && (
        <div className="space-y-6 max-w-3xl">

          {/* Stage 1 filters */}
          <div className="p-5 rounded-lg border border-border bg-card">
            <h3 className="font-semibold text-white text-sm mb-1">Stage 1 — Instant Filters</h3>
            <p className="text-xs text-muted-foreground mb-4">Applied before any scoring. Any match here returns score 0 and skips immediately — no AI call spent.</p>
            <div className="space-y-3">
              <div>
                <p className="text-xs font-medium text-red-400 uppercase tracking-wide mb-2">Hard disqualifiers <span className="text-muted-foreground normal-case font-normal">(auto-SKIP)</span></p>
                <div className="flex flex-wrap gap-1.5">
                  {["no marketing/communications terms","us citizen only","u.s. citizen only","must be a resident of","registered vendor in the state of","on-site weekly","in-person attendance required at bi-weekly","security clearance required"].map((kw) => (
                    <span key={kw} className="px-2 py-0.5 rounded-full bg-red-900/20 text-red-400 text-xs border border-red-900/40">{kw}</span>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-xs font-medium text-yellow-400 uppercase tracking-wide mb-2">International viability check <span className="text-muted-foreground normal-case font-normal">(non-Caribbean must pass)</span></p>
                <p className="text-xs text-muted-foreground mb-2">If the opportunity is outside Bahamas / Caribbean, it must show at least one of:</p>
                <div className="flex flex-wrap gap-1.5">
                  {["remote","virtual delivery","international bidders","international firms","worldwide","idb","world bank","undp","unicef","cdb","caricom","european union"].map((kw) => (
                    <span key={kw} className="px-2 py-0.5 rounded-full bg-yellow-900/20 text-yellow-400 text-xs border border-yellow-900/40">{kw}</span>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* 4-component formula */}
          <div className="p-5 rounded-lg border border-border bg-card">
            <h3 className="font-semibold text-white text-sm mb-1">Stage 2 — Scoring Formula</h3>
            <p className="text-xs text-muted-foreground mb-4">Opportunities that pass Stage 1 are scored across four components totalling 100 points.</p>
            <div className="grid grid-cols-2 gap-3">
              {[
                { pts: 35, label: "Geographic Alignment", color: "text-amber-400", desc: "Bahamas=35 · Caribbean=28 · SIDS=20 · LatAm=15 · Global=10" },
                { pts: 30, label: "Core Capabilities",    color: "text-blue-400",  desc: "Keyword match against ONWRD's services: marketing, branding, comms, PR, digital…" },
                { pts: 20, label: "Industry Vertical",    color: "text-emerald-400", desc: "Finance/Tourism=20 · Government=18 · NGO/Multilateral=16 · Health/Climate=10" },
                { pts: 15, label: "Scale & Feasibility",  color: "text-purple-400", desc: "Structured RFP signals: TOR, deliverables, milestones, budget, scope of work…" },
              ].map(({ pts, label, color, desc }) => (
                <div key={label} className="p-4 rounded-md bg-muted/20 border border-border">
                  <div className={`text-2xl font-bold ${color}`}>{pts} pts</div>
                  <div className="text-sm font-medium text-white mt-0.5">{label}</div>
                  <div className="text-xs text-muted-foreground mt-1 leading-relaxed">{desc}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Thresholds */}
          <div className="p-5 rounded-lg border border-border bg-card">
            <h3 className="font-semibold text-white text-sm mb-1">Recommendation Thresholds</h3>
            <p className="text-xs text-muted-foreground mb-4">Final fit score determines the recommendation shown in the Inbox.</p>
            <div className="space-y-2">
              {[
                { label: "🔥 PURSUE",   range: "≥ 62", note: "Strong fit across geography, capabilities, and sector", color: "border-emerald-800 bg-emerald-900/20 text-emerald-400" },
                { label: "⚡ CONSIDER", range: "40 – 61", note: "Partial fit — worth reviewing before deciding", color: "border-yellow-800 bg-yellow-900/20 text-yellow-400" },
                { label: "— SKIP",     range: "< 40",  note: "Poor fit or failed Stage 1 filter", color: "border-gray-700 bg-gray-900/20 text-gray-400" },
              ].map(({ label, range, note, color }) => (
                <div key={label} className={`flex items-center justify-between px-4 py-3 rounded-md border ${color}`}>
                  <div>
                    <span className="font-semibold text-sm">{label}</span>
                    <p className="text-xs opacity-70 mt-0.5">{note}</p>
                  </div>
                  <span className="text-sm font-mono font-bold">{range}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Geography detail */}
          <div className="p-5 rounded-lg border border-border bg-card">
            <h3 className="font-semibold text-white text-sm mb-1">Geographic Alignment Detail</h3>
            <p className="text-xs text-muted-foreground mb-4">Detected from country field, title, and description. Bahamas and Caribbean auto-pass Stage 1.</p>
            <div className="space-y-2">
              {[
                { region: "🇧🇸 Bahamas",      pts: 35, signals: "Nassau, Freeport, New Providence, Grand Bahama, Andros, Exuma…", highlight: true },
                { region: "🌴 Caribbean",     pts: 28, signals: "CARICOM, OECS, Jamaica, Barbados, Trinidad, Guyana, Belize, St Lucia…", highlight: false },
                { region: "🏝️ SIDS",          pts: 20, signals: "Small Island Developing States, Pacific Island, Maldives, Fiji…", highlight: false },
                { region: "🌎 Latin America", pts: 15, signals: "Mexico, Colombia, Peru, Brazil, Panama, Costa Rica…", highlight: false },
                { region: "🌐 Global",        pts: 10, signals: "Multilateral or remote-eligible international (passed Stage 1)", highlight: false },
              ].map(({ region, pts, signals, highlight }) => (
                <div key={region} className={`flex items-start gap-3 px-4 py-3 rounded-md border ${highlight ? "border-amber-800/50 bg-amber-900/10" : "border-border bg-muted/10"}`}>
                  <div className={`w-10 text-center text-lg font-bold flex-shrink-0 ${highlight ? "text-amber-400" : "text-white"}`}>{pts}</div>
                  <div className="flex-1 min-w-0">
                    <div className={`text-sm font-medium ${highlight ? "text-amber-300" : "text-white"}`}>{region}</div>
                    <div className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{signals}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Capability keywords */}
          <div className="p-5 rounded-lg border border-border bg-card">
            <h3 className="font-semibold text-white text-sm mb-1">Core Capabilities Keywords</h3>
            <p className="text-xs text-muted-foreground mb-4">Accumulate toward the 30-point capabilities component. Negative signals subtract.</p>
            <div className="space-y-4">
              <div>
                <p className="text-xs font-medium text-white uppercase tracking-wide mb-2">Elite <span className="text-muted-foreground normal-case font-normal">(+8 pts each)</span></p>
                <div className="flex flex-wrap gap-1.5">
                  {["marketing","communications","branding","campaign","public relations","media relations","media campaign","media strategy","communications strategy","marketing strategy","brand strategy","brand identity"].map((kw) => (
                    <span key={kw} className="px-2 py-0.5 rounded-full bg-white/10 text-white text-xs border border-white/25 font-medium">{kw}</span>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-xs font-medium text-emerald-400 uppercase tracking-wide mb-2">High <span className="text-muted-foreground normal-case font-normal">(+5 pts each)</span></p>
                <div className="flex flex-wrap gap-1.5">
                  {["rebranding","advertising","pr campaign","creative services","content strategy","copywriting","storytelling","messaging","tourism","destination marketing","hospitality","social media","digital marketing","digital campaign","video production","multimedia","graphic design","awareness campaign","community engagement","stakeholder engagement","outreach","advocacy","visibility campaign"].map((kw) => (
                    <span key={kw} className="px-2 py-0.5 rounded-full bg-emerald-900/20 text-emerald-400 text-xs border border-emerald-900/40">{kw}</span>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-xs font-medium text-yellow-400 uppercase tracking-wide mb-2">Medium <span className="text-muted-foreground normal-case font-normal">(+3 pts each)</span></p>
                <div className="flex flex-wrap gap-1.5">
                  {["consulting","advisory","strategic communications","communications plan","engagement plan","market research","visibility","documentation","knowledge management"].map((kw) => (
                    <span key={kw} className="px-2 py-0.5 rounded-full bg-yellow-900/20 text-yellow-400 text-xs border border-yellow-900/40">{kw}</span>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-2">Weak <span className="text-muted-foreground normal-case font-normal">(+2 pts, only when paired with a high signal)</span></p>
                <div className="flex flex-wrap gap-1.5">
                  {["capacity building","training","assessment","evaluation","survey","research","monitoring","reporting"].map((kw) => (
                    <span key={kw} className="px-2 py-0.5 rounded-full bg-slate-900/40 text-slate-400 text-xs border border-slate-700/40">{kw}</span>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-xs font-medium text-red-400 uppercase tracking-wide mb-2">Negative <span className="text-muted-foreground normal-case font-normal">(−6 pts each)</span></p>
                <div className="flex flex-wrap gap-1.5">
                  {["construction","civil works","road works","bridge","dam","dredging","drilling","water supply","sanitation","sewage","electricity","power plant","solar panel","medical equipment","pharmaceutical","drugs","office supplies","vehicles","fleet","food supply","catering","cleaning services","security services","it equipment","hardware","servers","software license","laboratory equipment","financial audit","external audit","structural engineering","geotechnical"].map((kw) => (
                    <span key={kw} className="px-2 py-0.5 rounded-full bg-red-900/20 text-red-400 text-xs border border-red-900/40">{kw}</span>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <p className="text-xs text-muted-foreground text-center pb-2">
            Scoring runs automatically on crawl. Use <strong className="text-white">⚡ Re-score with keywords</strong> in Run History to apply changes to existing items.
          </p>
        </div>
      )}

      {tab === "digest" && (
        <div className="space-y-6 max-w-xl">
          <div className="p-4 rounded-lg border border-border bg-card">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="font-medium text-white text-sm">Daily Digest Email</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Sent each morning after the 6am crawl with new Pursue and Consider opportunities.
                </p>
              </div>
              <div className="flex items-center gap-3">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => sendTestEmail.mutate()}
                  disabled={sendTestEmail.isPending}
                >
                  <Send className={`w-3.5 h-3.5 mr-1.5 ${sendTestEmail.isPending ? "animate-pulse" : ""}`} />
                  {sendTestEmail.isPending ? "Sending…" : "Send Test"}
                </Button>
                <Switch
                  checked={digest?.enabled ?? true}
                  onCheckedChange={(enabled) => updateDigest.mutate({ enabled })}
                />
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Recipients</p>
              {(digest?.emails ?? []).length === 0 && (
                <p className="text-xs text-muted-foreground italic">No recipients added yet.</p>
              )}
              {(digest?.emails ?? []).map((email) => (
                <div key={email} className="flex items-center justify-between gap-3 py-1.5 px-3 rounded bg-muted/20 border border-border">
                  <div className="flex items-center gap-2">
                    <Mail className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-sm text-white">{email}</span>
                  </div>
                  <button
                    onClick={() => removeEmail(email)}
                    className="text-muted-foreground hover:text-red-400 transition-colors"
                    title="Remove"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}

              <div className="flex gap-2 mt-3">
                <Input
                  placeholder="name@example.com"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addEmail()}
                  className="flex-1 h-9 text-sm"
                />
                <Button size="sm" onClick={addEmail} disabled={!newEmail.trim() || updateDigest.isPending}>
                  <Plus className="w-4 h-4 mr-1" /> Add
                </Button>
              </div>
            </div>
          </div>

        </div>
      )}

      {tab === "runs" && (
        <div className="space-y-2">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm text-muted-foreground">Last {runs.length} crawl runs</p>
            <button
              onClick={() => rescore.mutate()}
              disabled={rescore.isPending}
              className="text-xs px-3 py-1.5 rounded-md border border-border bg-card hover:bg-accent text-muted-foreground hover:text-white transition-colors disabled:opacity-50"
            >
              {rescore.isPending ? "Re-scoring…" : "⚡ Re-score with keywords"}
            </button>
          </div>
          {runs.length === 0 ? (
            <p className="text-muted-foreground text-sm py-8 text-center">No crawl runs yet. Trigger one from the Inbox or a source.</p>
          ) : (
            runs.map((run) => {
              const src = sources.find((s) => s.id === run.sourceId);
              return (
                <div key={run.id} className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card text-sm">
                  {run.status === "success" ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                  ) : run.status === "failed" ? (
                    <XCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                  ) : (
                    <Clock className="w-4 h-4 text-yellow-400 flex-shrink-0" />
                  )}
                  <span className="font-medium text-white flex-1">{src?.name ?? `Source #${run.sourceId}`}</span>
                  <span className="text-muted-foreground text-xs">{run.itemsNew} new</span>
                  <span className="text-muted-foreground text-xs">
                    {formatDistanceToNow(new Date(run.startedAt), { addSuffix: true })}
                  </span>
                  {run.errorMessage && (
                    <span className="text-red-400 text-xs truncate max-w-[200px]" title={run.errorMessage}>
                      {run.errorMessage}
                    </span>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
