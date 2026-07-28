import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import {
  Target, FileText, Sparkles, LayoutDashboard,
  Share2, ArrowRight, X, ChevronLeft, ChevronRight,
} from "lucide-react";

const STORAGE_KEY = "onwrd_tour_seen_v1";
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// ─── Step definitions ──────────────────────────────────────────────────────

interface Step {
  icon: React.ReactNode;
  eyebrow: string;
  title: string;
  body: React.ReactNode;
  action?: { label: string; href: string };
  visual: React.ReactNode;
}

function DiscoverVisual() {
  const rows = [
    { org: "World Bank",  title: "Caribbean Communications Strategy",  score: 88 },
    { org: "UNDP",        title: "Media & Outreach for Climate Project", score: 74 },
    { org: "CARICOM",     title: "Tourism Marketing Campaign 2026",     score: 91 },
  ];
  return (
    <div className="space-y-2">
      {rows.map(({ org, title, score }) => (
        <div key={title} className="flex items-center gap-3 bg-[#0d0d0d] border border-[#2a2a2a] rounded-lg px-3 py-2.5">
          <div className="flex-1 min-w-0">
            <p className="text-[11px] text-[#555] font-medium truncate">{org}</p>
            <p className="text-xs text-white font-medium truncate">{title}</p>
          </div>
          <div
            className="text-xs font-bold tabular-nums px-2 py-0.5 rounded-full shrink-0"
            style={{
              background: score >= 85 ? "#0000FF22" : "#ffffff0d",
              color: score >= 85 ? "#6680ff" : "#888",
            }}
          >
            {score}
          </div>
        </div>
      ))}
    </div>
  );
}

function AddVisual() {
  return (
    <div className="space-y-2">
      {[
        { icon: "📋", label: "Paste RFP text",    sub: "Copy from any website" },
        { icon: "📄", label: "Upload a document",  sub: "PDF, DOCX, or TXT" },
        { icon: "🔗", label: "Import from URL",    sub: "Paste a tender link" },
      ].map(({ icon, label, sub }) => (
        <div key={label} className="flex items-center gap-3 bg-[#0d0d0d] border border-[#2a2a2a] rounded-lg px-3 py-2.5">
          <span className="text-base shrink-0">{icon}</span>
          <div>
            <p className="text-xs text-white font-medium">{label}</p>
            <p className="text-[11px] text-[#555]">{sub}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function GenerateVisual() {
  return (
    <div className="space-y-2">
      {[
        { label: "Executive Summary",  done: true },
        { label: "Our Approach",       done: true },
        { label: "Deliverables",       done: true },
        { label: "Budget Overview",    done: false, active: true },
        { label: "About ONWRD",        done: false },
      ].map(({ label, done, active }) => (
        <div
          key={label}
          className={`flex items-center gap-3 rounded-lg px-3 py-2 border ${
            active ? "border-[#0000FF]/40 bg-[#0000FF]/10" : "border-[#2a2a2a] bg-[#0d0d0d]"
          }`}
        >
          <div
            className={`w-3.5 h-3.5 rounded-full shrink-0 flex items-center justify-center ${
              done ? "bg-emerald-500" : active ? "bg-[#0000FF] animate-pulse" : "bg-[#333]"
            }`}
          >
            {done && <svg viewBox="0 0 10 10" className="w-2 h-2 text-white" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 5l2.5 2.5L8 3"/></svg>}
          </div>
          <p className={`text-xs font-medium ${active ? "text-white" : done ? "text-[#666]" : "text-[#444]"}`}>{label}</p>
          {active && <p className="text-[10px] text-[#555] ml-auto animate-pulse">Writing…</p>}
        </div>
      ))}
    </div>
  );
}

function ReviewVisual() {
  return (
    <div className="rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] overflow-hidden">
      <div className="border-b border-[#2a2a2a] px-3 py-2 flex items-center justify-between">
        <p className="text-[11px] font-semibold text-[#888]">Executive Summary</p>
        <div className="flex items-center gap-1.5">
          <div className="w-5 h-5 rounded bg-[#1a1a1a] border border-[#333]" />
          <div className="w-5 h-5 rounded bg-[#1a1a1a] border border-[#333]" />
        </div>
      </div>
      <div className="p-3 space-y-1.5">
        {["We are a full-service communications agency", "specialising in Caribbean markets. Our team", "brings 15+ years of regional expertise to every", "engagement, from campaign strategy through to"].map((l, i) => (
          <div key={i} className="h-2 rounded-full bg-[#222]" style={{ width: `${[100,85,95,72][i]}%` }} />
        ))}
      </div>
      <div className="border-t border-[#2a2a2a] px-3 py-2">
        <div className="inline-block bg-[#0000FF]/20 border border-[#0000FF]/30 rounded px-2 py-0.5 text-[10px] text-[#6680ff]">✎ Edit section</div>
      </div>
    </div>
  );
}

function ExportVisual() {
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] px-4 py-3 flex items-center gap-3">
        <div className="w-8 h-8 rounded bg-[#1a73e8]/20 flex items-center justify-center shrink-0">
          <span className="text-sm">G</span>
        </div>
        <div className="flex-1">
          <p className="text-xs text-white font-medium">Export to Google Docs</p>
          <p className="text-[11px] text-[#555]">One click — editable, shareable</p>
        </div>
        <div className="w-5 h-5 rounded-full bg-emerald-500/20 flex items-center justify-center">
          <svg viewBox="0 0 10 10" className="w-2.5 h-2.5 text-emerald-400" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 5l2.5 2.5L8 3"/></svg>
        </div>
      </div>
      <div className="rounded-lg border border-[#2a2a2a] bg-[#0d0d0d] px-4 py-3 flex items-center gap-3 opacity-60">
        <div className="w-8 h-8 rounded bg-[#333] flex items-center justify-center shrink-0">
          <FileText className="w-4 h-4 text-[#888]" />
        </div>
        <div className="flex-1">
          <p className="text-xs text-white font-medium">Copy text</p>
          <p className="text-[11px] text-[#555]">Paste anywhere</p>
        </div>
      </div>
    </div>
  );
}

const STEPS: Step[] = [
  {
    icon: <Sparkles className="w-5 h-5" />,
    eyebrow: "Welcome to ONWRD",
    title: "Turn RFPs into proposals in minutes",
    body: (
      <>
        ONWRD watches procurement portals for you, scores every opportunity, and drafts a
        full proposal the moment you say go — all with your firm's voice and knowledge baked in.
        <br /><br />
        This walkthrough covers the four steps from discovery to export.
      </>
    ),
    visual: (
      <div className="grid grid-cols-2 gap-2">
        {[
          { icon: <Target className="w-4 h-4" />,        label: "Discover",  color: "#0000FF" },
          { icon: <FileText className="w-4 h-4" />,      label: "Add",       color: "#6680ff" },
          { icon: <Sparkles className="w-4 h-4" />,      label: "Generate",  color: "#6680ff" },
          { icon: <LayoutDashboard className="w-4 h-4" />, label: "Export",  color: "#0000FF" },
        ].map(({ icon, label, color }) => (
          <div key={label} className="flex flex-col items-center gap-2 bg-[#0d0d0d] border border-[#2a2a2a] rounded-xl py-4">
            <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: `${color}22`, color }}>
              {icon}
            </div>
            <p className="text-xs font-medium text-white">{label}</p>
          </div>
        ))}
      </div>
    ),
  },
  {
    icon: <Target className="w-5 h-5" />,
    eyebrow: "Step 1 — Discover",
    title: "Browse live opportunities",
    body: (
      <>
        The <strong className="text-white">Discover</strong> feed pulls fresh tenders from World Bank,
        UNDP, CARICOM, and Bahamas Gov every day. Each one gets a fit score so you can spot the
        best matches at a glance.
        <br /><br />
        For portals ONWRD can't reach automatically — IDB, CDB, CTO, EU — use the{" "}
        <strong className="text-white">Paste Text</strong> flow to add them manually.
      </>
    ),
    action: { label: "Open Discover", href: "/opportunities" },
    visual: <DiscoverVisual />,
  },
  {
    icon: <FileText className="w-5 h-5" />,
    eyebrow: "Step 2 — Add",
    title: "Bring in any RFP",
    body: (
      <>
        Found something outside Discover? Hit <strong className="text-white">+ New</strong> to add
        it three ways: paste the text you copied from a portal, upload a PDF or Word doc, or drop
        in a URL.
        <br /><br />
        ONWRD extracts the title, agency, deadline, and budget automatically so you don't have to
        fill anything in.
      </>
    ),
    action: { label: "Add an opportunity", href: "/new?mode=paste" },
    visual: <AddVisual />,
  },
  {
    icon: <Sparkles className="w-5 h-5" />,
    eyebrow: "Step 3 — Generate",
    title: "Draft a full proposal",
    body: (
      <>
        Open any opportunity and click <strong className="text-white">Generate Proposal</strong>.
        The AI reads the RFP, matches it against your Knowledge Base, and writes every section —
        exec summary, approach, deliverables, budget, and more.
        <br /><br />
        The whole draft usually takes under 90 seconds.
      </>
    ),
    visual: <GenerateVisual />,
  },
  {
    icon: <LayoutDashboard className="w-5 h-5" />,
    eyebrow: "Step 4 — Review",
    title: "Edit until it's right",
    body: (
      <>
        Each section has its own edit panel so you can refine the parts that need it without
        touching the rest. Switch to <strong className="text-white">Preview</strong> at any time
        to read the proposal as a flowing document.
        <br /><br />
        Regenerate individual sections if you want a different angle — the rest stays untouched.
      </>
    ),
    visual: <ReviewVisual />,
  },
  {
    icon: <Share2 className="w-5 h-5" />,
    eyebrow: "Step 5 — Export",
    title: "Send it out",
    body: (
      <>
        Connect Google Docs in <strong className="text-white">Settings → Google Docs</strong> and
        export any proposal with one click. You get a fully formatted, editable document ready to
        share with your client.
        <br /><br />
        No Google account yet? Copy the text and paste it wherever you need it.
      </>
    ),
    action: { label: "Set up Google Docs", href: "/settings" },
    visual: <ExportVisual />,
  },
];

// ─── Component ─────────────────────────────────────────────────────────────

interface WalkthroughWizardProps {
  open: boolean;
  onClose: () => void;
}

export function WalkthroughWizard({ open, onClose }: WalkthroughWizardProps) {
  const [step, setStep] = useState(0);
  const [, navigate] = useLocation();

  // Reset to first step each time it opens
  useEffect(() => { if (open) setStep(0); }, [open]);

  if (!open) return null;

  const current = STEPS[step];
  const isLast  = step === STEPS.length - 1;
  const isFirst = step === 0;

  function handleDone() {
    localStorage.setItem(STORAGE_KEY, "1");
    onClose();
  }

  function handleAction(href: string) {
    handleDone();
    navigate(href);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
      onClick={handleDone}
    >
      <div
        className="relative bg-[#0a0a0a] border border-[#2a2a2a] rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Top bar */}
        <div className="flex items-center justify-between px-6 pt-5 pb-0">
          {/* Step pills */}
          <div className="flex items-center gap-1.5">
            {STEPS.map((_, i) => (
              <button
                key={i}
                onClick={() => setStep(i)}
                className={`h-1.5 rounded-full transition-all ${
                  i === step ? "w-5 bg-[#0000FF]" : i < step ? "w-3 bg-[#444]" : "w-3 bg-[#222]"
                }`}
                aria-label={`Go to step ${i + 1}`}
              />
            ))}
          </div>

          <button
            onClick={handleDone}
            className="text-[#555] hover:text-white transition-colors"
            aria-label="Close walkthrough"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="grid md:grid-cols-2 gap-0 p-6 pt-5">
          {/* Left — text */}
          <div className="flex flex-col justify-between pr-0 md:pr-6">
            <div>
              {/* Eyebrow + icon */}
              <div className="flex items-center gap-2 mb-3">
                <div className="w-7 h-7 rounded-lg bg-[#0000FF]/20 text-[#6680ff] flex items-center justify-center shrink-0">
                  {current.icon}
                </div>
                <p className="text-xs font-semibold text-[#6680ff] tracking-wide uppercase">
                  {current.eyebrow}
                </p>
              </div>

              <h2 className="text-xl font-bold text-white leading-snug mb-3">
                {current.title}
              </h2>

              <p className="text-sm text-[#888] leading-relaxed">
                {current.body}
              </p>
            </div>

            {/* CTA */}
            {current.action && (
              <button
                onClick={() => handleAction(`${BASE}${current.action!.href}`)}
                className="mt-5 inline-flex items-center gap-2 text-sm font-medium text-[#6680ff] hover:text-white transition-colors"
              >
                {current.action.label}
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Right — visual */}
          <div className="mt-5 md:mt-0 md:border-l md:border-[#1e1e1e] md:pl-6 flex flex-col justify-center">
            {current.visual}
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-[#1e1e1e] px-6 py-4 flex items-center justify-between">
          <button
            onClick={() => setStep(s => s - 1)}
            disabled={isFirst}
            className="flex items-center gap-1.5 text-sm text-[#555] hover:text-white transition-colors disabled:opacity-0 disabled:pointer-events-none"
          >
            <ChevronLeft className="w-4 h-4" />
            Back
          </button>

          <span className="text-xs text-[#444] tabular-nums">
            {step + 1} / {STEPS.length}
          </span>

          {isLast ? (
            <button
              onClick={handleDone}
              className="flex items-center gap-1.5 px-4 py-2 bg-[#0000FF] hover:bg-[#0000dd] text-white text-sm font-medium rounded-lg transition-colors"
            >
              Get started
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          ) : (
            <button
              onClick={() => setStep(s => s + 1)}
              className="flex items-center gap-1.5 text-sm text-white font-medium hover:text-[#aaa] transition-colors"
            >
              Next
              <ChevronRight className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Hook — auto-show on first visit ───────────────────────────────────────

export function useWalkthrough() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const seen = localStorage.getItem(STORAGE_KEY);
    if (!seen) setOpen(true);
  }, []);

  return {
    open,
    show: () => setOpen(true),
    hide: () => setOpen(false),
  };
}
