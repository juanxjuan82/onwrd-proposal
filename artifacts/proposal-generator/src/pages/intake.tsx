import { useState, useEffect, useRef } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckCircle, Mail, Phone, UploadCloud, X, FileText } from "lucide-react";

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
    market: z.string().min(1, "Please select a geography"),
    marketOther: z.string().optional(),
    problems: z.array(z.string()).min(1, "Please select at least one"),
    problemsOther: z.string().optional(),
    agencyBefore: z.string().optional(),
    support: z.array(z.string()).min(1, "Please select at least one"),
    supportOther: z.string().optional(),
    investment: z.string().optional(),
    decisionStage: z.string().min(1, "Please select one"),
    projectType: z.string().min(1, "Please select a project type"),
    projectBrief: z.string().trim(),
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
const HEAR = ["Personal referral","LinkedIn","Instagram","Google / web search","Event or conference","Press or media","Existing ONWRD client","Other"];
const INDUSTRY = ["Hospitality & Tourism","Real Estate & Development","Technology","Financial Services","Non-Profit / Development Sector","Government & Public Sector","Consumer Goods & Retail","Other"];
const MARKET = ["The Bahamas","Caribbean (multi-island)","Caribbean + US","Latin America","North America","Global","Other"];
const PROBLEMS = ["People don't know who we are or what we do","We're entering a new market or launching something new","Our marketing is inconsistent, or the strategy is unclear","We've outgrown our current brand or how people think about us","Other"];
const SUPPORT = ["Figuring out our overall marketing direction","Creating content — writing, visuals, video","Getting press coverage and media attention","Making our brand look more professional and consistent","Building or improving our website","Growing and managing our social media","I'm not sure — I need guidance on where to start","Other"];
const INVESTMENT = ["Just starting out · Under $2,500/month","Ready to build · $2,500 – $5,000/month","Serious about growth · $5,000 – $10,000/month","Full partnership · $10,000+/month","Project-based — let's talk scope","Not sure yet — open to a recommendation"];
const AGENCY = ["No. This would be a first","Yes, and it worked well","Yes, with mixed results","We've managed marketing in-house"];
const DECISION = ["Ready to move, just need the right partner","Actively exploring options","Early stages but building the case internally","Not sure yet, still figuring out what we need"];
const PROJECT_TYPE = ["Brand Strategy","Content & Campaigns","Website","PR & Media","Social Media","Full Partnership","Not sure yet"];

// ─── Brief formatter ──────────────────────────────────────────────────────
function wo(v: string, o?: string) { return v === "Other" && o ? o : v; }
function mwo(vs: string[], o?: string) {
  return [...vs.filter(v => v !== "Other"), ...(vs.includes("Other") && o ? [o] : [])].join(", ");
}
function brief(v: V) {
  return `Project Brief\nDate: ${new Date().toISOString().split("T")[0]}\nClient: ${v.orgName}\n\nContact\n${v.firstName} ${v.lastName} · ${v.jobTitle}\nEmail: ${v.email}\nPhone: ${v.phone||"n/a"} · Preferred: ${v.preferredContact||"n/a"}\nHeard via: ${wo(v.hearAbout,v.hearAboutOther)}\n\nOrg\n${v.orgName} · ${v.website||"n/a"}\nIndustry: ${wo(v.industry,v.industryOther)}\nMarket: ${wo(v.market,v.marketOther)}\n\nBrief\nProblems: ${mwo(v.problems,v.problemsOther)}\nAgency history: ${v.agencyBefore||"n/a"}\nSupport needed: ${mwo(v.support,v.supportOther)}\nInvestment: ${v.investment||"n/a"}\nProject type: ${v.projectType}\n\n${v.projectBrief}\n\nTiming\nDecision stage: ${v.decisionStage}`.trim();
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

// ─── Section card ─────────────────────────────────────────────────────────
function Section({ num, title, children }: { num: number; title: string; children: React.ReactNode }) {
  return (
    <Card className="bg-[#0a0a0a] border-[#1e1e1e]">
      <CardHeader className="pb-4 pt-5 px-6">
        <CardTitle className="flex items-center gap-3 text-sm font-semibold text-white">
          <span className="flex items-center justify-center w-6 h-6 rounded-full border border-[#0000FF] text-[#0000FF] text-[11px] font-bold shrink-0">
            {num}
          </span>
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-6 pb-6">
        {children}
      </CardContent>
    </Card>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────
export default function Intake() {
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitErr, setSubmitErr] = useState<string|null>(null);
  const [briefFile, setBriefFile] = useState<File | null>(null);
  const [draftId, setDraftId] = useState<number | null>(null);
  const [autosaved, setAutosaved] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const form = useForm<V>({
    resolver: zodResolver(intakeSchema),
    defaultValues: {
      firstName:"",lastName:"",jobTitle:"",email:"",phone:"",preferredContact:"",
      hearAbout:"",hearAboutOther:"",orgName:"",website:"",
      industry:"",industryOther:"",market:"",marketOther:"",
      problems:[],problemsOther:"",agencyBefore:"",
      support:[],supportOther:"",investment:"",decisionStage:"",
      projectType:"",projectBrief:"",
    },
  });
  const { formState: { errors, isSubmitting } } = form;
  const hearAbout = form.watch("hearAbout");
  const industry = form.watch("industry");
  const market = form.watch("market");
  const problems = form.watch("problems");
  const support = form.watch("support");

  // ─── Autosave: fire when Section 1 is filled ────────────────────────────
  const firstName = form.watch("firstName");
  const lastName = form.watch("lastName");
  const jobTitle = form.watch("jobTitle");
  const email = form.watch("email");
  const phone = form.watch("phone");
  const preferredContact = form.watch("preferredContact");

  const section1Complete =
    firstName.trim().length > 0 &&
    lastName.trim().length > 0 &&
    jobTitle.trim().length > 0 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  useEffect(() => {
    if (!section1Complete) return;
    const timer = setTimeout(async () => {
      try {
        const resp = await fetch(`${BASE}/api/intake/draft`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ firstName, lastName, jobTitle, email, phone, preferredContact }),
        });
        if (resp.ok) {
          const data = await resp.json() as { id: number };
          setDraftId(data.id);
          setAutosaved(true);
          setTimeout(() => setAutosaved(false), 3000);
        }
      } catch { /* silent — non-blocking */ }
    }, 800);
    return () => clearTimeout(timer);
  }, [firstName, lastName, jobTitle, email, phone, preferredContact, section1Complete]);

  // ─── Submit ─────────────────────────────────────────────────────────────
  const submit = async (v: V) => {
    // Require either typed brief or uploaded file
    if (!briefFile && v.projectBrief.trim().length < 10) {
      form.setError("projectBrief", { message: "Please describe your project (at least 10 characters) or upload a document above" });
      return;
    }

    setBusy(true); setSubmitErr(null);
    try {
      const formData = new FormData();
      formData.append("briefText", brief(v));
      formData.append("clientName", v.orgName);
      formData.append("industry", wo(v.industry, v.industryOther));
      if (briefFile) formData.append("briefFile", briefFile);
      if (draftId) formData.append("draftId", String(draftId));

      const r = await fetch(`${BASE}/api/intake`, { method: "POST", body: formData });
      if (!r.ok) {
        let msg = "Couldn't submit. Please check your connection and try again.";
        try { const j = await r.json(); if (j?.error) msg = j.error; } catch { /* ignore */ }
        throw new Error(msg);
      }
      setDone(true);
    } catch (e) {
      setSubmitErr(e instanceof Error ? e.message : "Couldn't submit. Please check your connection and try again.");
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

  return (
    <div className="min-h-screen bg-black text-white">
      {/* Header */}
      <header className="border-b border-[#1a1a1a] px-6 py-3 sticky top-0 bg-black z-10">
        <div className="max-w-4xl mx-auto">
          <img src="/onwrd-logo-white.png" alt="ONWRD" className="h-[22px] object-contain object-left" />
        </div>
      </header>

      {/* Body */}
      <main className="max-w-4xl mx-auto w-full px-4 sm:px-6 py-8">
        <div className="mb-8">
          <h1 className="text-xl font-semibold text-white mb-1">Tell us about your project</h1>
          <p className="text-[13px] text-[#555]">Fill in the sections below and we'll prepare a tailored proposal.</p>
        </div>

        <form onSubmit={form.handleSubmit(submit)} noValidate className="space-y-5">

          {/* ── Section 1: Contact Details ── */}
          <Section num={1} title="Contact Details">
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 items-start">
                <Field label="First name" req>
                  <Input className="h-9 text-[13px]" {...form.register("firstName")} />
                  <Err msg={errors.firstName?.message} />
                </Field>
                <Field label="Last name" req>
                  <Input className="h-9 text-[13px]" {...form.register("lastName")} />
                  <Err msg={errors.lastName?.message} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3 items-start">
                <Field label="Job title" req>
                  <Input className="h-9 text-[13px]" {...form.register("jobTitle")} />
                  <Err msg={errors.jobTitle?.message} />
                </Field>
                <Field label="Email" req>
                  <Input className="h-9 text-[13px]" type="email" {...form.register("email")} />
                  <Err msg={errors.email?.message} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3 items-start">
                <Field label="Phone" opt>
                  <Input className="h-9 text-[13px]" {...form.register("phone")} />
                </Field>
                <Field label="Preferred contact" opt>
                  <Controller control={form.control} name="preferredContact" render={({ field }) => (
                    <div className="flex gap-2">
                      {[
                        { val: "Email", icon: <Mail className="w-4 h-4 shrink-0" />, label: "Email" },
                        { val: "Phone", icon: <Phone className="w-4 h-4 shrink-0" />, label: "Phone" },
                      ].map(({ val, icon, label }) => (
                        <button
                          key={val}
                          type="button"
                          onClick={() => field.onChange(field.value === val ? "" : val)}
                          className={`flex items-center gap-2 rounded border px-3 py-2 text-[13px] transition-colors flex-1 justify-center min-w-0
                            ${field.value === val
                              ? "border-[#0000FF] bg-[#0000FF]/10 text-white font-medium"
                              : "border-[#262626] bg-[#0d0d0d] text-[#777] hover:border-[#0000FF]/50 hover:text-[#ccc]"}`}
                        >
                          {icon}
                          <span className="truncate">{label}</span>
                        </button>
                      ))}
                    </div>
                  )} />
                </Field>
              </div>
              {autosaved && (
                <p className="text-[11px] text-[#555] flex items-center gap-1">
                  <CheckCircle className="w-3 h-3 text-[#00FFD5]" />
                  Contact details saved
                </p>
              )}
            </div>
          </Section>

          {/* ── Section 2: Company & Market ── */}
          <Section num={2} title="Company & Market">
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 items-start">
                <Field label="Organisation name" req>
                  <Input className="h-9 text-[13px]" {...form.register("orgName")} />
                  <Err msg={errors.orgName?.message} />
                </Field>
                <Field label="Website" opt>
                  <Input className="h-9 text-[13px]" placeholder="https://…" {...form.register("website")} />
                </Field>
              </div>

              <Field label="How did you find us?" req>
                <div className="mt-1 space-y-1.5">
                  <Controller control={form.control} name="hearAbout" render={({ field }) => (
                    <Radio opts={HEAR} val={field.value} set={field.onChange} />
                  )} />
                  <Err msg={errors.hearAbout?.message} />
                  {hearAbout === "Other" && (
                    <Input className="h-9 text-[13px] mt-1" placeholder="Please specify…" {...form.register("hearAboutOther")} />
                  )}
                  <Err msg={errors.hearAboutOther?.message} />
                </div>
              </Field>

              <Field label="Industry" req>
                <div className="mt-1 space-y-1.5">
                  <Controller control={form.control} name="industry" render={({ field }) => (
                    <Radio opts={INDUSTRY} val={field.value} set={field.onChange} />
                  )} />
                  <Err msg={errors.industry?.message} />
                  {industry === "Other" && (
                    <Input className="h-9 text-[13px] mt-1" placeholder="Please specify…" {...form.register("industryOther")} />
                  )}
                  <Err msg={errors.industryOther?.message} />
                </div>
              </Field>

              <Field label="Geography — where do you operate?" req>
                <div className="mt-1 space-y-1.5">
                  <Controller control={form.control} name="market" render={({ field }) => (
                    <Radio opts={MARKET} val={field.value} set={field.onChange} />
                  )} />
                  <Err msg={errors.market?.message} />
                  {market === "Other" && (
                    <Input className="h-9 text-[13px] mt-1" placeholder="Please specify…" {...form.register("marketOther")} />
                  )}
                  <Err msg={errors.marketOther?.message} />
                </div>
              </Field>
            </div>
          </Section>

          {/* ── Section 3: The Challenge ── */}
          <Section num={3} title="The Challenge">
            <div className="space-y-4">
              <Field label="What's the challenge?" req>
                <div className="mt-1 space-y-1.5">
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
              </Field>

              <Field label="Have you worked with a marketing agency before?" opt>
                <div className="mt-1">
                  <Controller control={form.control} name="agencyBefore" render={({ field }) => (
                    <Radio opts={AGENCY} val={field.value ?? ""} set={field.onChange} />
                  )} />
                </div>
              </Field>

              <Field label="Where do you need help?" req>
                <div className="mt-1 space-y-1.5">
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
              </Field>
            </div>
          </Section>

          {/* ── Section 4: Project & Investment ── */}
          <Section num={4} title="Project & Investment">
            <div className="space-y-4">
              <Field label="Project type" req>
                <div className="mt-1">
                  <Controller control={form.control} name="projectType" render={({ field }) => (
                    <Radio opts={PROJECT_TYPE} val={field.value} set={field.onChange} />
                  )} />
                  <Err msg={errors.projectType?.message} />
                </div>
              </Field>

              <Field label="Project brief" req>
                <div className="mt-1 space-y-2">
                  <Textarea
                    className="text-[13px] resize-none"
                    rows={5}
                    placeholder="Tell us about your goals, challenges, or anything that helps us understand what you need…"
                    {...form.register("projectBrief")}
                  />
                  <div className="flex justify-between items-start">
                    <Err msg={errors.projectBrief?.message} />
                    <span className="text-[11px] text-[#444] ml-auto">{form.watch("projectBrief").length} chars</span>
                  </div>

                  {/* File upload area */}
                  <div className="border border-dashed border-[#2a2a2a] rounded-lg p-4">
                    <p className="text-[11px] text-[#555] mb-2">
                      Have an existing brief? Upload your RFP or project document instead of (or alongside) typing.
                    </p>
                    {briefFile ? (
                      <div className="flex items-center gap-2 bg-[#111] border border-[#222] rounded px-3 py-2">
                        <FileText className="w-4 h-4 text-[#0000FF] shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] text-white truncate">{briefFile.name}</p>
                          <p className="text-[11px] text-[#555]">{formatBytes(briefFile.size)}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => { setBriefFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}
                          className="text-[#555] hover:text-white transition-colors shrink-0"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="flex items-center gap-2 text-[13px] text-[#666] hover:text-white transition-colors"
                      >
                        <UploadCloud className="w-4 h-4 shrink-0" />
                        <span>Choose file</span>
                        <span className="text-[#444]">· PDF, DOCX, TXT · Max 20 MB</span>
                      </button>
                    )}
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".pdf,.docx,.txt"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) setBriefFile(f);
                      }}
                    />
                  </div>
                </div>
              </Field>

              <Field label="How are you thinking about investment?" opt>
                <div className="mt-1">
                  <p className="text-[11px] text-[#555] mb-1.5">Optional — helps us tailor our thinking</p>
                  <Controller control={form.control} name="investment" render={({ field }) => (
                    <Radio opts={INVESTMENT} val={field.value ?? ""} set={field.onChange} cols={1} />
                  )} />
                </div>
              </Field>

              <Field label="Where are you in your decision-making?" req>
                <div className="mt-1 space-y-1.5">
                  <Controller control={form.control} name="decisionStage" render={({ field }) => (
                    <Radio opts={DECISION} val={field.value} set={field.onChange} cols={1} />
                  )} />
                  <Err msg={errors.decisionStage?.message} />
                </div>
              </Field>
            </div>
          </Section>

          {/* Submit */}
          <div className="flex flex-col items-end gap-2 pt-1 pb-8">
            {submitErr && <p className="text-[11px] text-destructive self-start">{submitErr}</p>}
            <Button type="submit" size="sm" className="h-9 px-8 text-[13px]" disabled={busy || isSubmitting}>
              {busy ? "Submitting…" : "Submit"}
            </Button>
          </div>
        </form>
      </main>
    </div>
  );
}
