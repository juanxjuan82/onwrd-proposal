import { useState, useRef, useCallback, useEffect } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  UploadCloud,
  Link2,
  FileText,
  CheckCircle2,
  XCircle,
  Loader2,
  ArrowRight,
  AlertCircle,
} from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type Mode = "file" | "url";

type AnalysisStatus =
  | "opportunity_found"
  | "analysing"
  | "strategy_ready"
  | "no_bid"
  | "analysis_failed"
  | string;

interface ImportResult {
  id: number;
  title: string;
  status: AnalysisStatus;
  fitScore?: number | null;
  fitLevel?: string | null;
  recommendationScore?: number | null;
}

const TERMINAL: AnalysisStatus[] = ["strategy_ready", "no_bid", "analysis_failed"];

function statusLabel(status: AnalysisStatus): string {
  switch (status) {
    case "opportunity_found": return "Queued for analysis…";
    case "analysing": return "Analysing — extracting requirements and scoring…";
    case "strategy_ready": return "Analysis complete";
    case "no_bid": return "Analysis complete — not a fit";
    case "analysis_failed": return "Analysis failed";
    default: return status;
  }
}

function fitBadgeColor(level: string | null | undefined) {
  switch (level) {
    case "excellent": return "bg-green-600 text-white";
    case "high": return "bg-emerald-700 text-white";
    case "medium": return "bg-yellow-600 text-white";
    case "low": return "bg-orange-600 text-white";
    case "no_bid": return "bg-zinc-700 text-zinc-300";
    default: return "bg-zinc-800 text-zinc-300";
  }
}

export default function SettingsImport() {
  const [mode, setMode] = useState<Mode>("file");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [polling, setPolling] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setPolling(false);
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const startPolling = useCallback((id: number) => {
    setPolling(true);
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`${BASE}/api/opportunities/${id}`);
        if (!r.ok) return;
        const data = (await r.json()) as ImportResult;
        setResult(data);
        if (TERMINAL.includes(data.status)) {
          stopPolling();
        }
      } catch {
        // keep polling
      }
    }, 3000);
  }, [stopPolling]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) { setFile(dropped); setErr(null); }
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    if (f) { setFile(f); setErr(null); }
  };

  const reset = () => {
    stopPolling();
    setResult(null);
    setFile(null);
    setUrl("");
    setErr(null);
  };

  const submit = async () => {
    setErr(null);
    if (mode === "file" && !file) { setErr("Select a file to upload."); return; }
    if (mode === "url" && !url.trim()) { setErr("Enter a URL to fetch."); return; }

    setBusy(true);
    try {
      const fd = new FormData();
      if (mode === "file" && file) {
        fd.append("file", file);
      } else if (mode === "url") {
        fd.append("url", url.trim());
      }

      const r = await fetch(`${BASE}/api/tenders/manual`, { method: "POST", body: fd });
      if (!r.ok) {
        let msg = "Import failed. Please try again.";
        try { const j = await r.json(); if (j?.error) msg = j.error; } catch { /* ignore */ }
        throw new Error(msg);
      }
      const data = (await r.json()) as ImportResult;
      setResult(data);
      if (!TERMINAL.includes(data.status)) {
        startPolling(data.id);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Import failed. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const isComplete = result && TERMINAL.includes(result.status);
  const isBusy = busy || polling;

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-white mb-1">Manual Tender Import</h1>
        <p className="text-[#666] text-sm">
          Drop a document or paste a URL to feed it directly into the analysis pipeline.
        </p>
      </div>

      {!result && (
        <div className="space-y-6">
          {/* Mode toggle */}
          <div className="flex gap-2">
            <button
              onClick={() => { setMode("file"); setErr(null); }}
              className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium border transition-colors ${
                mode === "file"
                  ? "border-[#0000FF] text-white bg-[#0000FF]/10"
                  : "border-[#333] text-[#666] hover:text-white hover:border-[#555]"
              }`}
            >
              <UploadCloud className="w-4 h-4" />
              File Upload
            </button>
            <button
              onClick={() => { setMode("url"); setErr(null); }}
              className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium border transition-colors ${
                mode === "url"
                  ? "border-[#0000FF] text-white bg-[#0000FF]/10"
                  : "border-[#333] text-[#666] hover:text-white hover:border-[#555]"
              }`}
            >
              <Link2 className="w-4 h-4" />
              URL
            </button>
          </div>

          {/* File drop zone */}
          {mode === "file" && (
            <div
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-lg p-12 flex flex-col items-center justify-center gap-3 cursor-pointer transition-colors select-none ${
                dragging
                  ? "border-[#0000FF] bg-[#0000FF]/5"
                  : file
                  ? "border-[#333] bg-[#111]"
                  : "border-[#333] hover:border-[#555] bg-[#0d0d0d]"
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.docx,.txt"
                className="hidden"
                onChange={handleFileChange}
              />
              {file ? (
                <>
                  <FileText className="w-8 h-8 text-[#0000FF]" />
                  <p className="text-white font-medium text-sm">{file.name}</p>
                  <p className="text-[#555] text-xs">
                    {(file.size / 1024).toFixed(0)} KB · Click to change
                  </p>
                </>
              ) : (
                <>
                  <UploadCloud className="w-8 h-8 text-[#444]" />
                  <p className="text-[#888] text-sm">
                    Drag and drop or <span className="text-white underline">browse</span>
                  </p>
                  <p className="text-[#555] text-xs">PDF, DOCX, TXT · Max 50 MB</p>
                </>
              )}
            </div>
          )}

          {/* URL input */}
          {mode === "url" && (
            <div>
              <Input
                value={url}
                onChange={(e) => { setUrl(e.target.value); setErr(null); }}
                placeholder="https://procurement.bahamas.gov.bs/tenders/…"
                className="bg-[#111] border-[#333] text-white placeholder:text-[#444] h-11"
                onKeyDown={(e) => { if (e.key === "Enter" && !isBusy) void submit(); }}
              />
            </div>
          )}

          {err && (
            <div className="flex items-start gap-2 text-red-400 text-sm bg-red-950/30 border border-red-900/40 rounded-md px-3 py-2">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              {err}
            </div>
          )}

          <Button
            onClick={() => void submit()}
            disabled={isBusy || (mode === "file" ? !file : !url.trim())}
            className="bg-white text-black hover:bg-white/90 font-semibold h-10 px-6 text-sm"
          >
            {isBusy ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Processing…</>
            ) : (
              "Ingest & Analyze"
            )}
          </Button>
        </div>
      )}

      {/* In-progress state */}
      {result && !isComplete && (
        <div className="border border-[#222] rounded-lg p-6 space-y-4">
          <div className="flex items-center gap-3">
            <Loader2 className="w-5 h-5 text-[#0000FF] animate-spin flex-shrink-0" />
            <div>
              <p className="text-white text-sm font-medium truncate">{result.title}</p>
              <p className="text-[#555] text-xs mt-0.5">{statusLabel(result.status)}</p>
            </div>
          </div>
          <div className="w-full bg-[#1a1a1a] rounded-full h-1">
            <div
              className="bg-[#0000FF] h-1 rounded-full transition-all duration-700"
              style={{
                width: result.status === "opportunity_found" ? "20%" : result.status === "analysing" ? "65%" : "100%",
              }}
            />
          </div>
        </div>
      )}

      {/* Completed result */}
      {isComplete && result && (
        <div className="border border-[#222] rounded-lg p-6 space-y-5">
          <div className="flex items-start gap-3">
            {result.status === "analysis_failed" ? (
              <XCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
            ) : result.status === "no_bid" ? (
              <AlertCircle className="w-5 h-5 text-yellow-500 flex-shrink-0 mt-0.5" />
            ) : (
              <CheckCircle2 className="w-5 h-5 text-emerald-500 flex-shrink-0 mt-0.5" />
            )}
            <div className="flex-1 min-w-0">
              <p className="text-white text-sm font-medium truncate">{result.title}</p>
              <p className="text-[#555] text-xs mt-0.5">{statusLabel(result.status)}</p>
            </div>
          </div>

          {(result.fitLevel || result.fitScore != null) && (
            <div className="flex items-center gap-3 pt-1">
              {result.fitLevel && (
                <Badge className={`text-xs font-semibold uppercase tracking-wide px-2.5 py-0.5 ${fitBadgeColor(result.fitLevel)}`}>
                  {result.fitLevel === "no_bid" ? "No Bid" : result.fitLevel}
                </Badge>
              )}
              {result.fitScore != null && result.fitLevel !== "no_bid" && (
                <span className="text-[#888] text-sm">
                  Fit score: <span className="text-white font-semibold">{result.fitScore}</span>
                  <span className="text-[#555]">/100</span>
                </span>
              )}
            </div>
          )}

          {result.status === "no_bid" && (
            <p className="text-[#666] text-sm">
              This opportunity was scored as <strong className="text-[#888]">no bid</strong> — strategy generation was skipped. It may be an individual job posting or outside ONWRD's scope.
            </p>
          )}

          {result.status === "analysis_failed" && (
            <p className="text-red-400 text-sm">
              Analysis encountered an error. The record has been saved — you can retry scoring from the opportunity detail page.
            </p>
          )}

          <div className="flex items-center gap-3 pt-1">
            {result.status !== "analysis_failed" && (
              <Link href={`/opportunities/${result.id}`}>
                <Button size="sm" className="bg-white text-black hover:bg-white/90 font-semibold text-xs h-8 px-4">
                  View Opportunity <ArrowRight className="w-3.5 h-3.5 ml-1.5" />
                </Button>
              </Link>
            )}
            <button
              onClick={reset}
              className="text-[#555] text-xs hover:text-white transition-colors"
            >
              Import another
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
