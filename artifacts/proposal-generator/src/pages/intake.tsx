import { useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckCircle, ArrowLeft, ArrowRight, Mail, Phone } from "lucide-react";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// ─── Schema ───────────────────────────────────────────────────────────────
const intakeSchema = z
  .object({
    firstName: z.string().trim().min(1, "First name is required"),
    lastName: z.string().trim().min(1, "Last name is required"),
    jobTitle: z.string().trim().min(1, "Job title is required"),
    email: z.string().trim().min(1, "Email is required").email("Enter a valid email"),
    phone: z.string().optional(),
    preferredContact: z.string().optional(),
    hearAbout: z.string().min(1, "Please select one"),
    hearAboutOther: z.string().optional(),
    orgName: z.string().trim().min(1, "Organisation name is required"),
    website: z.string().optional(),
    industry: z.string().min(1, "Please select your industry"),
    industryOther: z.string().optional(),
    market: z.string().min(1, "Please select a market"),
    marketOther: z.string().optional(),
    problems: z.array(z.string()).min(1, "Please select at least one"),
    problemsOther: z.string().optional(),
    agencyBefore: z.string().optional(),
    support: z.array(z.string()).min(1, "Please select at least one"),
    supportOther: z.string().optional(),
    investment: z.string().optional(),
    decisionStage: z.string().min(1, "Please select one"),
  })
  .superRefine((v, ctx) => {
    const req = (sel: boolean, val: string | undefined, path: string) => {
      if (sel && !val?.trim())
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: "Please specify" });
    };
    req(v.hearAbout === "Other", v.hearAboutOther, "hearAboutOther");
    req(v.industry === "Other", v.industryOther, "industryOther");
    req(v.market === "Other", v.marketOther, "marketOther");
    req(v.problems.includes("Other"), v.problemsOther, "problemsOther");
    req(v.support.includes("Other"), v.supportOther, "supportOther");
  });

type V = z.infer<typeof intakeSchema>;

// ─── Options ──────────────────────────────────────────────────────────────
const CONTACT = ["Email", "Phone"];
const HEAR = ["Personal referral","LinkedIn","Instagram","Google / web search","Event or conference","Press or media","Existing ONWRD client","Other"];
const INDUSTRY = ["Hospitality & Tourism","Real Estate & Development","Technology","Financial Services","Non-Profit / Development Sector","Government & Public Sector","Consumer Goods & Retail","Other"];
const MARKET = ["The Bahamas","Caribbean (multi-island)","Caribbean + US","Latin America","North America","Global","Other"];
const PROBLEMS = ["People don't know who we are or what we do","We're entering a new market or launching something new","Our marketing is inconsistent, or the strategy is unclear","We've outgrown our current brand or how people think about us","Other"];
const SUPPORT = ["Figuring out our overall marketing direction","Creating content — writing, visuals, video","Getting press coverage and media attention","Making our brand look more professional and consistent","Building or improving our website","Growing and managing our social media","I'm not sure — I need guidance on where to start","Other"];
const INVESTMENT = ["Just starting out · Under $2,500/month","Ready to build · $2,500 – $5,000/month","Serious about growth · $5,000 – $10,000/month","Full partnership · $10,000+/month","Project-based — let's talk scope","Not sure yet — open to a recommendation"];
const AGENCY = ["No. This would be a first","Yes, and it worked well","Yes, with mixed results","We've managed marketing in-house"];
const DECISION = ["Ready to move, just need the right partner","Actively exploring options","Early stages but building the case internally","Not sure yet, still figuring out what we need"];

// ─── Steps ────────────────────────────────────────────────────────────────
// Each step is sized to fit on a 768px viewport with no scroll.
const STEPS = [
  { label: "You",        title: "Let's start with you"       },
  { label: "Discovery",  title: "How did you find us?"        },
  { label: "Org",        title: "Your organisation"           },
  { label: "Market",     title: "Where do you operate?"       },
  { label: "Challenge",  title: "What's the challenge?"       },
  { label: "Support",    title: "Where do you need help?"     },
  { label: "Investment", title: "How are you thinking about investment?" },
  { label: "Timing",     title: "Last step"                   },
] as const;

const STEP_FIELDS: (keyof V)[][] = [
  ["firstName","lastName","jobTitle","email","phone","preferredContact"],
  ["hearAbout","hearAboutOther","orgName","website"],
  ["industry","industryOther"],
  ["market","marketOther"],
  ["problems","problemsOther","agencyBefore"],
  ["support","supportOther"],
  ["investment"],
  ["decisionStage"],
];

// ─── Brief formatter ──────────────────────────────────────────────────────
function wo(v: string, o?: string) { return v === "Other" && o ? o : v; }
function mwo(vs: string[], o?: string) {
  return [...vs.filter(v => v !== "Other"), ...(vs.includes("Other") && o ? [o] : [])].join(", ");
}
function brief(v: V) {
  return `Project Brief\nDate: ${new Date().toISOString().split("T")[0]}\nClient: ${v.orgName}\n\nContact\n${v.firstName} ${v.lastName} · ${v.jobTitle}\nEmail: ${v.email}\nPhone: ${v.phone||"n/a"} · Preferred: ${v.preferredContact||"n/a"}\nHeard via: ${wo(v.hearAbout,v.hearAboutOther)}\n\nOrg\n${v.orgName} · ${v.website||"n/a"}\nIndustry: ${wo(v.industry,v.industryOther)}\nMarket: ${wo(v.market,v.marketOther)}\n\nBrief\nProblems: ${mwo(v.problems,v.problemsOther)}\nAgency history: ${v.agencyBefore||"n/a"}\nSupport needed: ${mwo(v.support,v.supportOther)}\nInvestment: ${v.investment||"n/a"}\n\nTiming\nDecision stage: ${v.decisionStage}`.trim();
}

// ─── Tile components ──────────────────────────────────────────────────────
function Tile({ label, checked, onToggle, type = "radio" }: {
  label: string; checked: boolean; onToggle: () => void; type?: "radio"|"checkbox";
}) {
  return (
    <label className={`flex items-center gap-2 rounded border px-3 py-1.5 text-[13px] leading-snug cursor-pointer transition-colors select-none
      ${checked ? "border-[#0000FF] bg-[#0000FF]/10 text-white font-medium" : "border-[#262626] bg-[#0d0d0d] text-[#777] hover:border-[#0000FF]/50 hover:text-[#ccc]"}`}>
      <input type={type} className="accent-primary shrink-0 w-3 h-3" checked={checked} onChange={onToggle} />
      <span>{label}</span>
    </label>
  );
}

function Radio({ opts, val, set, cols = 2 }: { opts: string[]; val: string; set: (v: string) => void; cols?: 1|2 }) {
  return (
    <div className={`grid gap-1.5 ${cols === 1 ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2"}`}>
      {opts.map(o => <Tile key={o} label={o} type="radio" checked={val === o} onToggle={() => set(o)} />)}
    </div>
  );
}

function Checks({ opts, val, set }: { opts: string[]; val: string[]; set: (v: string[]) => void }) {
  const toggle = (o: string) => set(val.includes(o) ? val.filter(x => x !== o) : [...val, o]);
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
      {opts.map(o => <Tile key={o} label={o} type="checkbox" checked={val.includes(o)} onToggle={() => toggle(o)} />)}
    </div>
  );
}

function Err({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="text-[11px] text-destructive mt-1">{msg}</p>;
}

function Field({ label, req, opt, children }: { label: string; req?: boolean; opt?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-[#999] flex items-center gap-1">
        {label}
        {req && <span className="text-destructive">*</span>}
        {opt && <span className="text-[#555] font-normal">(optional)</span>}
      </span>
      {children}
    </div>
  );
}

// ─── Progress ─────────────────────────────────────────────────────────────
function Bar({ step, total }: { step: number; total: number }) {
  return (
    <div className="mb-5 shrink-0">
      <div className="flex justify-between mb-1.5">
        <span className="text-[10px] tracking-widest text-[#444] uppercase">Step {step+1} / {total}</span>
        <span className="text-[10px] text-[#444]">{STEPS[step].label}</span>
      </div>
      <div className="h-[2px] bg-[#1c1c1c] rounded-full">
        <div
          className="h-full bg-[#0000FF] rounded-full transition-[width] duration-300"
          style={{ width: `${((step+1)/total)*100}%` }}
        />
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────
export default function Intake() {
  const [step, setStep] = useState(0);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string|null>(null);

  const form = useForm<V>({
    resolver: zodResolver(intakeSchema),
    defaultValues: {
      firstName:"",lastName:"",jobTitle:"",email:"",phone:"",preferredContact:"",
      hearAbout:"",hearAboutOther:"",orgName:"",website:"",
      industry:"",industryOther:"",market:"",marketOther:"",
      problems:[],problemsOther:"",agencyBefore:"",
      support:[],supportOther:"",investment:"",decisionStage:"",
    },
  });
  const { formState: { errors, isSubmitting } } = form;
  const w = form.watch;

  const advance = async () => {
    if (await form.trigger(STEP_FIELDS[step])) setStep(s => s+1);
  };

  const submit = async (v: V) => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`${BASE}/api/intake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ briefText: brief(v), clientName: v.orgName, industry: wo(v.industry, v.industryOther) }),
      });
      if (!r.ok) {
        let msg = "Couldn't submit. Please check your connection and try again.";
        try { const j = await r.json(); if (j?.error) msg = j.error; } catch { /* ignore */ }
        throw new Error(msg);
      }
      setDone(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Couldn't submit. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center">
        <div className="text-center space-y-3 max-w-xs px-6">
          <div className="mx-auto w-12 h-12 rounded-full bg-[#111] border border-[#222] flex items-center justify-center">
            <CheckCircle className="w-6 h-6" style={{ color: "#00FFD5" }} />
          </div>
          <h2 className="text-xl font-semibold">Thank you.</h2>
          <p className="text-[#666] text-sm leading-relaxed">
            We'll be in touch within two business days.{" "}
            <a href="https://onwrdadvisors.com" target="_blank" rel="noopener noreferrer" className="text-white underline underline-offset-2">onwrdadvisors.com</a>
          </p>
        </div>
      </div>
    );
  }

  const hearAbout = w("hearAbout");
  const industry = w("industry");
  const market = w("market");
  const problems = w("problems");
  const support = w("support");

  return (
    <div className="h-screen bg-black text-white flex flex-col overflow-hidden">
      {/* Header */}
      <header className="shrink-0 border-b border-[#1a1a1a] px-6 py-3">
        <div className="max-w-3xl mx-auto">
          <img src="/onwrd-logo-white.png" alt="ONWRD" className="h-[22px] object-contain object-left" />
        </div>
      </header>

      {/* Body */}
      <main className="flex-1 overflow-hidden flex flex-col max-w-3xl mx-auto w-full px-6 py-5">
        <Bar step={step} total={STEPS.length} />

        {/* Step title */}
        <div className="shrink-0 mb-4">
          <h2 className="text-base font-semibold text-white">{STEPS[step].title}</h2>
        </div>

        <form onSubmit={form.handleSubmit(submit)} noValidate className="flex-1 flex flex-col overflow-hidden">
          {/* Step content — no overflow */}
          <div className="flex-1">

            {/* ── 1: You ── */}
            {step === 0 && (
              <div className="space-y-2.5">
                <div className="grid grid-cols-2 gap-2.5 items-start">
                  <Field label="First name" req>
                    <Input className="h-9 text-[13px]" {...form.register("firstName")} />
                    <Err msg={errors.firstName?.message} />
                  </Field>
                  <Field label="Last name" req>
                    <Input className="h-9 text-[13px]" {...form.register("lastName")} />
                    <Err msg={errors.lastName?.message} />
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-2.5 items-start">
                  <Field label="Job title" req>
                    <Input className="h-9 text-[13px]" {...form.register("jobTitle")} />
                    <Err msg={errors.jobTitle?.message} />
                  </Field>
                  <Field label="Email" req>
                    <Input className="h-9 text-[13px]" type="email" {...form.register("email")} />
                    <Err msg={errors.email?.message} />
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-2.5 items-start">
                  <Field label="Phone" opt>
                    <Input className="h-9 text-[13px]" {...form.register("phone")} />
                  </Field>
                  <Field label="Preferred contact" opt>
                    <Controller control={form.control} name="preferredContact" render={({ field }) => (
                      <div className="flex gap-2">
                        {[
                          { val: "Email", icon: <Mail className="w-4 h-4" />, label: "Email" },
                          { val: "Phone", icon: <Phone className="w-4 h-4" />, label: "Phone" },
                        ].map(({ val, icon, label }) => (
                          <button
                            key={val}
                            type="button"
                            onClick={() => field.onChange(field.value === val ? "" : val)}
                            className={`flex items-center gap-2 rounded border px-4 py-2 text-[13px] transition-colors flex-1 justify-center
                              ${field.value === val
                                ? "border-[#0000FF] bg-[#0000FF]/10 text-white font-medium"
                                : "border-[#262626] bg-[#0d0d0d] text-[#777] hover:border-[#0000FF]/50 hover:text-[#ccc]"}`}
                          >
                            {icon}
                            <span>{label}</span>
                          </button>
                        ))}
                      </div>
                    )} />
                  </Field>
                </div>
              </div>
            )}

            {/* ── 2: Discovery + Org basics ── */}
            {step === 1 && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Controller control={form.control} name="hearAbout" render={({ field }) => (
                    <Radio opts={HEAR} val={field.value} set={field.onChange} />
                  )} />
                  <Err msg={errors.hearAbout?.message} />
                  {hearAbout === "Other" && (
                    <Input className="h-9 text-[13px]" placeholder="Please specify…" {...form.register("hearAboutOther")} />
                  )}
                  <Err msg={errors.hearAboutOther?.message} />
                </div>
                <div className="grid grid-cols-2 gap-2.5 items-start pt-1">
                  <Field label="Organisation name" req>
                    <Input className="h-9 text-[13px]" {...form.register("orgName")} />
                    <Err msg={errors.orgName?.message} />
                  </Field>
                  <Field label="Website" opt>
                    <Input className="h-9 text-[13px]" placeholder="https://…" {...form.register("website")} />
                  </Field>
                </div>
              </div>
            )}

            {/* ── 3: Industry ── */}
            {step === 2 && (
              <div className="space-y-1.5">
                <Controller control={form.control} name="industry" render={({ field }) => (
                  <Radio opts={INDUSTRY} val={field.value} set={field.onChange} />
                )} />
                <Err msg={errors.industry?.message} />
                {industry === "Other" && (
                  <Input className="h-9 text-[13px]" placeholder="Please specify…" {...form.register("industryOther")} />
                )}
                <Err msg={errors.industryOther?.message} />
              </div>
            )}

            {/* ── 4: Market ── */}
            {step === 3 && (
              <div className="space-y-1.5">
                <Controller control={form.control} name="market" render={({ field }) => (
                  <Radio opts={MARKET} val={field.value} set={field.onChange} />
                )} />
                <Err msg={errors.market?.message} />
                {market === "Other" && (
                  <Input className="h-9 text-[13px]" placeholder="Please specify…" {...form.register("marketOther")} />
                )}
                <Err msg={errors.marketOther?.message} />
              </div>
            )}

            {/* ── 5: Problems + Agency ── */}
            {step === 4 && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <p className="text-[11px] text-[#555]">Select all that apply</p>
                  <Controller control={form.control} name="problems" render={({ field }) => (
                    <Checks opts={PROBLEMS} val={field.value} set={field.onChange} />
                  )} />
                  <Err msg={errors.problems?.message} />
                  {problems.includes("Other") && (
                    <Input className="h-9 text-[13px]" placeholder="Please specify…" {...form.register("problemsOther")} />
                  )}
                  <Err msg={errors.problemsOther?.message} />
                </div>
                <Field label="Have you worked with a marketing agency before?" opt>
                  <Controller control={form.control} name="agencyBefore" render={({ field }) => (
                    <Radio opts={AGENCY} val={field.value ?? ""} set={field.onChange} />
                  )} />
                </Field>
              </div>
            )}

            {/* ── 6: Support ── */}
            {step === 5 && (
              <div className="space-y-1.5">
                <p className="text-[11px] text-[#555]">Select all that apply</p>
                <Controller control={form.control} name="support" render={({ field }) => (
                  <Checks opts={SUPPORT} val={field.value} set={field.onChange} />
                )} />
                <Err msg={errors.support?.message} />
                {support.includes("Other") && (
                  <Input className="h-9 text-[13px]" placeholder="Please specify…" {...form.register("supportOther")} />
                )}
                <Err msg={errors.supportOther?.message} />
              </div>
            )}

            {/* ── 7: Investment ── */}
            {step === 6 && (
              <div className="space-y-1.5">
                <p className="text-[11px] text-[#555]">Optional — helps us tailor our thinking</p>
                <Controller control={form.control} name="investment" render={({ field }) => (
                  <Radio opts={INVESTMENT} val={field.value ?? ""} set={field.onChange} cols={1} />
                )} />
              </div>
            )}

            {/* ── 8: Timing ── */}
            {step === 7 && (
              <div className="space-y-3">
                <p className="text-[13px] text-[#666]">Where are you in your decision-making?</p>
                <Controller control={form.control} name="decisionStage" render={({ field }) => (
                  <Radio opts={DECISION} val={field.value} set={field.onChange} cols={1} />
                )} />
                <Err msg={errors.decisionStage?.message} />
                {err && <p className="text-[11px] text-destructive">{err}</p>}
              </div>
            )}
          </div>

          {/* Navigation */}
          <div className={`flex pt-4 shrink-0 ${step > 0 ? "justify-between" : "justify-end"}`}>
            {step > 0 && (
              <button
                type="button"
                onClick={() => setStep(s => s-1)}
                className="flex items-center gap-1 text-[12px] text-[#444] hover:text-white transition-colors py-2"
              >
                <ArrowLeft className="w-3 h-3" /> Back
              </button>
            )}
            {step < STEPS.length - 1 ? (
              <Button type="button" size="sm" onClick={advance} className="gap-1.5 h-9 px-5 text-[13px]">
                {step === 6 ? "Almost done" : "Next"} <ArrowRight className="w-3.5 h-3.5" />
              </Button>
            ) : (
              <Button type="submit" size="sm" className="h-9 px-6 text-[13px]" disabled={busy || isSubmitting}>
                {busy ? "Submitting…" : "Submit"}
              </Button>
            )}
          </div>
        </form>
      </main>
    </div>
  );
}
