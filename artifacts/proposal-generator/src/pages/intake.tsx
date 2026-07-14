import { useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, ArrowLeft, ArrowRight } from "lucide-react";

// ─── Schema ───────────────────────────────────────────────────────────────
const intakeSchema = z
  .object({
    firstName: z.string().trim().min(1, "First name is required"),
    lastName: z.string().trim().min(1, "Last name is required"),
    jobTitle: z.string().trim().min(1, "Job title is required"),
    email: z.string().trim().min(1, "Email is required").email("Enter a valid email"),
    phone: z.string().optional(),
    preferredContact: z.string().optional(),
    hearAbout: z.string().min(1, "Please tell us how you heard about ONWRD"),
    hearAboutOther: z.string().optional(),

    orgName: z.string().trim().min(1, "Organization name is required"),
    website: z.string().optional(),
    industry: z.string().min(1, "Industry / service category is required"),
    industryOther: z.string().optional(),
    market: z.string().min(1, "Primary market / geography is required"),
    marketOther: z.string().optional(),

    problems: z.array(z.string()).min(1, "Please select at least one"),
    problemsOther: z.string().optional(),
    support: z.array(z.string()).min(1, "Please select at least one"),
    supportOther: z.string().optional(),
    investment: z.string().optional(),
    agencyBefore: z.string().optional(),

    decisionStage: z.string().min(1, "Please select where you are"),
  })
  .superRefine((v, ctx) => {
    const requireOther = (selected: boolean, text: string | undefined, path: string) => {
      if (selected && !text?.trim()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: "Please specify" });
      }
    };
    requireOther(v.hearAbout === "Other", v.hearAboutOther, "hearAboutOther");
    requireOther(v.industry === "Other", v.industryOther, "industryOther");
    requireOther(v.market === "Other", v.marketOther, "marketOther");
    requireOther(v.problems.includes("Other"), v.problemsOther, "problemsOther");
    requireOther(v.support.includes("Other"), v.supportOther, "supportOther");
  });

type IntakeValues = z.infer<typeof intakeSchema>;

// ─── Options ──────────────────────────────────────────────────────────────
const CONTACT_OPTIONS = ["Email", "Phone"];
const HEAR_OPTIONS = [
  "Personal referral", "LinkedIn", "Instagram", "Google / web search",
  "Event or conference", "Press or media", "Existing ONWRD client", "Other",
];
const INDUSTRY_OPTIONS = [
  "Hospitality & Tourism", "Real Estate & Development", "Technology",
  "Financial Services", "Non-Profit / Development Sector",
  "Government & Public Sector", "Consumer Goods & Retail", "Other",
];
const MARKET_OPTIONS = [
  "The Bahamas", "Caribbean (multi-island)", "Caribbean + US",
  "Latin America", "North America", "Global", "Other",
];
const PROBLEM_OPTIONS = [
  "People don't know who we are or what we do",
  "We're entering a new market or launching something new",
  "Our marketing is inconsistent, or the strategy is unclear",
  "We've outgrown our current brand or how people think about us",
  "Other",
];
const SUPPORT_OPTIONS = [
  "Figuring out our overall marketing direction",
  "Creating content — writing, visuals, video",
  "Getting press coverage and media attention",
  "Making our brand look more professional and consistent",
  "Building or improving our website",
  "Growing and managing our social media",
  "I'm not sure — I need guidance on where to start",
  "Other",
];
const INVESTMENT_OPTIONS = [
  "Just starting out · Under $2,500/month",
  "Ready to build · $2,500 – $5,000/month",
  "Serious about growth · $5,000 – $10,000/month",
  "Full partnership · $10,000+/month",
  "Project-based — let's talk scope",
  "Not sure yet — open to a recommendation",
];
const AGENCY_OPTIONS = [
  "No. This would be a first",
  "Yes, and it worked well",
  "Yes, with mixed results",
  "We've managed marketing in-house",
];
const DECISION_OPTIONS = [
  "Ready to move, just need the right partner",
  "Actively exploring options",
  "Early stages but building the case internally",
  "Not sure yet, still figuring out what we need",
];

// ─── Steps config ─────────────────────────────────────────────────────────
const STEPS = [
  { label: "You", kicker: "01" },
  { label: "Organisation", kicker: "02" },
  { label: "The Brief", kicker: "03" },
  { label: "Timing", kicker: "04" },
];

const STEP_FIELDS: (keyof IntakeValues)[][] = [
  ["firstName", "lastName", "jobTitle", "email", "phone", "preferredContact", "hearAbout", "hearAboutOther"],
  ["orgName", "website", "industry", "industryOther", "market", "marketOther"],
  ["problems", "problemsOther", "support", "supportOther", "investment", "agencyBefore"],
  ["decisionStage"],
];

// ─── Format brief ─────────────────────────────────────────────────────────
function withOther(value: string, other?: string) {
  return value === "Other" && other ? other : value;
}
function multiWithOther(values: string[], other?: string) {
  return [
    ...values.filter((v) => v !== "Other"),
    ...(values.includes("Other") && other ? [other] : []),
  ].join(", ");
}
function formatBrief(v: IntakeValues): string {
  const today = new Date().toISOString().split("T")[0];
  return `Project Brief

Date: ${today}
Potential Client: ${v.orgName}
Project Name: ${v.orgName}

Contact
Name: ${v.firstName} ${v.lastName}
Job Title: ${v.jobTitle}
Email: ${v.email}
Phone: ${v.phone || "n/a"}
Preferred Contact Method: ${v.preferredContact || "n/a"}
How they heard about ONWRD: ${withOther(v.hearAbout, v.hearAboutOther)}

Organization
Company: ${v.orgName}
Website: ${v.website || "n/a"}
Industry / Service Category: ${withOther(v.industry, v.industryOther)}
Primary Market / Geography: ${withOther(v.market, v.marketOther)}

The Brief
Problem to solve: ${multiWithOther(v.problems, v.problemsOther)}
Where they need the most support: ${multiWithOther(v.support, v.supportOther)}
Investment thinking: ${v.investment || "n/a"}
Prior agency experience: ${v.agencyBefore || "n/a"}

Timing
Decision-making stage: ${v.decisionStage}`.trim();
}

// ─── Sub-components ────────────────────────────────────────────────────────
function CheckboxGroup({ options, value, onChange }: {
  options: string[]; value: string[]; onChange: (v: string[]) => void;
}) {
  const toggle = (opt: string) =>
    onChange(value.includes(opt) ? value.filter((v) => v !== opt) : [...value, opt]);
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {options.map((opt) => (
        <label key={opt} className={`flex items-center gap-2.5 rounded-[4px] border px-3 py-2.5 text-sm cursor-pointer transition-colors
          ${value.includes(opt) ? "border-[#0000FF] bg-[#0000FF]/10 text-white font-medium" : "border-[#333] bg-black text-[#999] hover:border-[#0000FF] hover:text-white"}`}>
          <input type="checkbox" className="accent-primary shrink-0" checked={value.includes(opt)} onChange={() => toggle(opt)} />
          {opt}
        </label>
      ))}
    </div>
  );
}

function RadioGroup({ options, value, onChange, columns = 2 }: {
  options: string[]; value: string; onChange: (v: string) => void; columns?: 1 | 2;
}) {
  return (
    <div className={`grid grid-cols-1 ${columns === 2 ? "sm:grid-cols-2" : ""} gap-2`}>
      {options.map((opt) => (
        <label key={opt} className={`flex items-center gap-2.5 rounded-[4px] border px-3 py-2.5 text-sm cursor-pointer transition-colors
          ${value === opt ? "border-[#0000FF] bg-[#0000FF]/10 text-white font-medium" : "border-[#333] bg-black text-[#999] hover:border-[#0000FF] hover:text-white"}`}>
          <input type="radio" className="accent-primary shrink-0" checked={value === opt} onChange={() => onChange(opt)} />
          {opt}
        </label>
      ))}
    </div>
  );
}

function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="text-xs text-destructive mt-1">{msg}</p>;
}

// ─── Progress bar ─────────────────────────────────────────────────────────
function ProgressBar({ current, total }: { current: number; total: number }) {
  return (
    <div className="mb-8">
      <div className="flex items-center gap-0">
        {Array.from({ length: total }).map((_, i) => (
          <div key={i} className="flex items-center flex-1">
            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 transition-all
              ${i < current ? "bg-[#0000FF] text-white" : i === current ? "bg-[#0000FF] text-white ring-2 ring-[#0000FF]/30" : "bg-[#1a1a1a] text-[#555] border border-[#333]"}`}>
              {i < current ? "✓" : i + 1}
            </div>
            {i < total - 1 && (
              <div className={`flex-1 h-px mx-1 transition-colors ${i < current ? "bg-[#0000FF]" : "bg-[#222]"}`} />
            )}
          </div>
        ))}
      </div>
      <div className="flex justify-between mt-2">
        {STEPS.map((s, i) => (
          <span key={i} className={`text-[10px] tracking-wide uppercase ${i === current ? "text-white" : i < current ? "text-[#0000FF]" : "text-[#444]"}`}>
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────
export default function Intake() {
  const [step, setStep] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const intake = useForm<IntakeValues>({
    resolver: zodResolver(intakeSchema),
    defaultValues: {
      firstName: "", lastName: "", jobTitle: "", email: "", phone: "",
      preferredContact: "", hearAbout: "", hearAboutOther: "",
      orgName: "", website: "", industry: "", industryOther: "",
      market: "", marketOther: "",
      problems: [], problemsOther: "", support: [], supportOther: "",
      investment: "", agencyBefore: "", decisionStage: "",
    },
  });

  const { errors } = intake.formState;
  const hearAbout = intake.watch("hearAbout");
  const industry = intake.watch("industry");
  const market = intake.watch("market");
  const problems = intake.watch("problems");
  const support = intake.watch("support");

  const next = async () => {
    const valid = await intake.trigger(STEP_FIELDS[step]);
    if (valid) setStep((s) => s + 1);
  };

  const handleSubmit = async (values: IntakeValues) => {
    setSubmitting(true);
    setSubmitError(null);
    const brief = formatBrief(values);
    try {
      const res = await fetch("/api/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          briefText: brief,
          clientName: values.orgName,
          industry: withOther(values.industry, values.industryOther),
        }),
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      setSubmitted(true);
    } catch {
      setSubmitError("We couldn't submit your form. Please check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="min-h-screen bg-black text-white flex flex-col">
        <header className="bg-black border-b border-[#222]">
          <div className="max-w-2xl mx-auto px-6 py-4">
            <img src="/onwrd-logo-white.png" alt="ONWRD" className="h-7 object-contain object-left" />
          </div>
        </header>
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="bg-black border border-[#222] rounded-[4px] p-12 text-center space-y-4 max-w-md w-full">
            <div className="mx-auto w-14 h-14 rounded-full bg-[#111] flex items-center justify-center">
              <CheckCircle className="w-7 h-7" style={{ color: "#00FFD5" }} />
            </div>
            <h1 className="text-2xl font-bold text-white">Thank you.</h1>
            <p className="text-muted-foreground leading-relaxed">
              We look forward to learning more about your organization and will be in touch within two business days.
              In the meantime, learn more about who we are at{" "}
              <a href="https://onwrdadvisors.com" target="_blank" rel="noopener noreferrer" className="text-white underline underline-offset-2">onwrdadvisors.com</a>.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black text-white flex flex-col">
      <header className="bg-black border-b border-[#222]">
        <div className="max-w-2xl mx-auto px-6 py-4">
          <img src="/onwrd-logo-white.png" alt="ONWRD" className="h-7 object-contain object-left" />
        </div>
      </header>

      <main className="flex-1 max-w-2xl mx-auto w-full px-6 py-10">
        {/* Intro — only on step 0 */}
        {step === 0 && (
          <div className="mb-8">
            <div className="text-[11px] tracking-[0.15em] text-[#999] mb-2">PROPOSAL INTAKE FORM</div>
            <h1 className="text-3xl font-bold text-white mb-3 tracking-tight">Tell us about your organization</h1>
            <p className="text-muted-foreground leading-relaxed">
              This helps us shape a proposal specific to your situation. Your information is treated with full confidentiality.
            </p>
          </div>
        )}

        <ProgressBar current={step} total={STEPS.length} />

        <form onSubmit={intake.handleSubmit(handleSubmit)} noValidate>
          {/* ── Step 0: You ── */}
          {step === 0 && (
            <div className="space-y-5">
              <div>
                <div className="text-[11px] tracking-[0.15em] text-[#999] mb-1">01</div>
                <h2 className="text-xl font-semibold mb-5">Let's start with you</h2>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="firstName" className="mb-1.5 block">First Name <span className="text-destructive">*</span></Label>
                  <Input id="firstName" {...intake.register("firstName")} />
                  <FieldError msg={errors.firstName?.message} />
                </div>
                <div>
                  <Label htmlFor="lastName" className="mb-1.5 block">Last Name <span className="text-destructive">*</span></Label>
                  <Input id="lastName" {...intake.register("lastName")} />
                  <FieldError msg={errors.lastName?.message} />
                </div>
                <div>
                  <Label htmlFor="jobTitle" className="mb-1.5 block">Job Title <span className="text-destructive">*</span></Label>
                  <Input id="jobTitle" {...intake.register("jobTitle")} />
                  <FieldError msg={errors.jobTitle?.message} />
                </div>
                <div>
                  <Label htmlFor="email" className="mb-1.5 block">Email Address <span className="text-destructive">*</span></Label>
                  <Input id="email" type="email" {...intake.register("email")} />
                  <FieldError msg={errors.email?.message} />
                </div>
                <div>
                  <Label htmlFor="phone" className="mb-1.5 block">Phone <span className="text-muted-foreground text-xs">(optional)</span></Label>
                  <Input id="phone" {...intake.register("phone")} />
                </div>
                <div>
                  <Label className="mb-2 block">Preferred Contact <span className="text-muted-foreground text-xs">(optional)</span></Label>
                  <Controller control={intake.control} name="preferredContact" render={({ field }) => (
                    <RadioGroup options={CONTACT_OPTIONS} value={field.value ?? ""} onChange={field.onChange} />
                  )} />
                </div>
              </div>

              <div>
                <Label className="mb-2 block">How did you hear about ONWRD? <span className="text-destructive">*</span></Label>
                <Controller control={intake.control} name="hearAbout" render={({ field }) => (
                  <RadioGroup options={HEAR_OPTIONS} value={field.value} onChange={field.onChange} />
                )} />
                <FieldError msg={errors.hearAbout?.message} />
                {hearAbout === "Other" && (
                  <>
                    <Input className="mt-2" placeholder="Please specify..." {...intake.register("hearAboutOther")} />
                    <FieldError msg={errors.hearAboutOther?.message} />
                  </>
                )}
              </div>
            </div>
          )}

          {/* ── Step 1: Organisation ── */}
          {step === 1 && (
            <div className="space-y-5">
              <div>
                <div className="text-[11px] tracking-[0.15em] text-[#999] mb-1">02</div>
                <h2 className="text-xl font-semibold mb-5">Your organisation</h2>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="orgName" className="mb-1.5 block">Organisation Name <span className="text-destructive">*</span></Label>
                  <Input id="orgName" {...intake.register("orgName")} />
                  <FieldError msg={errors.orgName?.message} />
                </div>
                <div>
                  <Label htmlFor="website" className="mb-1.5 block">Website <span className="text-muted-foreground text-xs">(optional)</span></Label>
                  <Input id="website" placeholder="https://yourwebsite.com" {...intake.register("website")} />
                </div>
              </div>

              <div>
                <Label className="mb-2 block">Industry / Service Category <span className="text-destructive">*</span></Label>
                <Controller control={intake.control} name="industry" render={({ field }) => (
                  <RadioGroup options={INDUSTRY_OPTIONS} value={field.value} onChange={field.onChange} />
                )} />
                <FieldError msg={errors.industry?.message} />
                {industry === "Other" && (
                  <>
                    <Input className="mt-2" placeholder="Please specify..." {...intake.register("industryOther")} />
                    <FieldError msg={errors.industryOther?.message} />
                  </>
                )}
              </div>

              <div>
                <Label className="mb-2 block">Primary Market / Geography <span className="text-destructive">*</span></Label>
                <Controller control={intake.control} name="market" render={({ field }) => (
                  <RadioGroup options={MARKET_OPTIONS} value={field.value} onChange={field.onChange} />
                )} />
                <FieldError msg={errors.market?.message} />
                {market === "Other" && (
                  <>
                    <Input className="mt-2" placeholder="Please specify..." {...intake.register("marketOther")} />
                    <FieldError msg={errors.marketOther?.message} />
                  </>
                )}
              </div>
            </div>
          )}

          {/* ── Step 2: The Brief ── */}
          {step === 2 && (
            <div className="space-y-6">
              <div>
                <div className="text-[11px] tracking-[0.15em] text-[#999] mb-1">03</div>
                <h2 className="text-xl font-semibold mb-5">The brief</h2>
              </div>

              <div>
                <Label className="mb-2 block">
                  What problem are you trying to solve? <span className="text-destructive">*</span>
                  <span className="text-muted-foreground text-xs ml-1">(select all that apply)</span>
                </Label>
                <Controller control={intake.control} name="problems" render={({ field }) => (
                  <CheckboxGroup options={PROBLEM_OPTIONS} value={field.value} onChange={field.onChange} />
                )} />
                <FieldError msg={errors.problems?.message} />
                {problems.includes("Other") && (
                  <>
                    <Input className="mt-2" placeholder="Please specify..." {...intake.register("problemsOther")} />
                    <FieldError msg={errors.problemsOther?.message} />
                  </>
                )}
              </div>

              <div>
                <Label className="mb-2 block">
                  Where do you need the most support? <span className="text-destructive">*</span>
                  <span className="text-muted-foreground text-xs ml-1">(select all that apply)</span>
                </Label>
                <Controller control={intake.control} name="support" render={({ field }) => (
                  <CheckboxGroup options={SUPPORT_OPTIONS} value={field.value} onChange={field.onChange} />
                )} />
                <FieldError msg={errors.support?.message} />
                {support.includes("Other") && (
                  <>
                    <Input className="mt-2" placeholder="Please specify..." {...intake.register("supportOther")} />
                    <FieldError msg={errors.supportOther?.message} />
                  </>
                )}
              </div>

              <div>
                <Label className="mb-2 block">How are you thinking about investment? <span className="text-muted-foreground text-xs">(optional)</span></Label>
                <Controller control={intake.control} name="investment" render={({ field }) => (
                  <RadioGroup options={INVESTMENT_OPTIONS} value={field.value ?? ""} onChange={field.onChange} columns={1} />
                )} />
              </div>

              <div>
                <Label className="mb-2 block">Have you worked with a marketing agency before? <span className="text-muted-foreground text-xs">(optional)</span></Label>
                <Controller control={intake.control} name="agencyBefore" render={({ field }) => (
                  <RadioGroup options={AGENCY_OPTIONS} value={field.value ?? ""} onChange={field.onChange} />
                )} />
              </div>
            </div>
          )}

          {/* ── Step 3: Timing + Submit ── */}
          {step === 3 && (
            <div className="space-y-5">
              <div>
                <div className="text-[11px] tracking-[0.15em] text-[#999] mb-1">04</div>
                <h2 className="text-xl font-semibold mb-2">Timing</h2>
                <p className="text-sm text-muted-foreground mb-5">Last step — where are you in your decision-making?</p>
              </div>

              <div>
                <Controller control={intake.control} name="decisionStage" render={({ field }) => (
                  <RadioGroup options={DECISION_OPTIONS} value={field.value} onChange={field.onChange} columns={1} />
                )} />
                <FieldError msg={errors.decisionStage?.message} />
              </div>

              {submitError && <p className="text-sm text-destructive">{submitError}</p>}
            </div>
          )}

          {/* ── Navigation ── */}
          <div className={`flex mt-8 ${step > 0 ? "justify-between" : "justify-end"}`}>
            {step > 0 && (
              <Button type="button" variant="ghost" onClick={() => setStep((s) => s - 1)} className="gap-2 text-[#999] hover:text-white">
                <ArrowLeft className="w-4 h-4" /> Back
              </Button>
            )}

            {step < STEPS.length - 1 ? (
              <Button type="button" onClick={next} className="gap-2 min-w-28">
                Next <ArrowRight className="w-4 h-4" />
              </Button>
            ) : (
              <Button type="submit" size="lg" className="min-w-32" disabled={submitting}>
                {submitting ? "Submitting…" : "Submit"}
              </Button>
            )}
          </div>
        </form>
      </main>

      <footer className="text-center text-xs text-muted-foreground py-8">
        ONWRD Advisors · Nassau, The Bahamas · onwrdadvisors.com
      </footer>
    </div>
  );
}
