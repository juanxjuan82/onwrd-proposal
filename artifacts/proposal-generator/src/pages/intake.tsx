import { useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle } from "lucide-react";

// ─── Schema ───────────────────────────────────────────────────────────────
const intakeSchema = z
  .object({
    // 01 · Let's start with you
    firstName: z.string().trim().min(1, "First name is required"),
    lastName: z.string().trim().min(1, "Last name is required"),
    jobTitle: z.string().trim().min(1, "Job title is required"),
    email: z.string().trim().min(1, "Email is required").email("Enter a valid email"),
    phone: z.string().optional(),
    preferredContact: z.string().optional(),
    hearAbout: z.string().min(1, "Please tell us how you heard about ONWRD"),
    hearAboutOther: z.string().optional(),

    // 02 · Your organization
    orgName: z.string().trim().min(1, "Organization name is required"),
    website: z.string().optional(),
    industry: z.string().min(1, "Industry / service category is required"),
    industryOther: z.string().optional(),
    market: z.string().min(1, "Primary market / geography is required"),
    marketOther: z.string().optional(),

    // 03 · The brief
    problems: z.array(z.string()).min(1, "Please select at least one"),
    problemsOther: z.string().optional(),
    support: z.array(z.string()).min(1, "Please select at least one"),
    supportOther: z.string().optional(),
    investment: z.string().optional(),
    agencyBefore: z.string().optional(),

    // 06 · Timing
    decisionStage: z.string().min(1, "Please select where you are"),
  })
  .superRefine((v, ctx) => {
    const requireOther = (
      selected: boolean,
      text: string | undefined,
      path: string,
    ) => {
      if (selected && !text?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [path],
          message: "Please specify",
        });
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
  "Personal referral",
  "LinkedIn",
  "Instagram",
  "Google / web search",
  "Event or conference",
  "Press or media",
  "Existing ONWRD client",
  "Other",
];

const INDUSTRY_OPTIONS = [
  "Hospitality & Tourism",
  "Real Estate & Development",
  "Technology",
  "Financial Services",
  "Non-Profit / Development Sector",
  "Government & Public Sector",
  "Consumer Goods & Retail",
  "Other",
];

const MARKET_OPTIONS = [
  "The Bahamas",
  "Caribbean (multi-island)",
  "Caribbean + US",
  "Latin America",
  "North America",
  "Global",
  "Other",
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

// ─── Format intake → brief text ───────────────────────────────────────────
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
  const industry = withOther(v.industry, v.industryOther);
  const market = withOther(v.market, v.marketOther);
  const problems = multiWithOther(v.problems, v.problemsOther);
  const support = multiWithOther(v.support, v.supportOther);

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
Industry / Service Category: ${industry}
Primary Market / Geography: ${market}

The Brief
Problem to solve: ${problems}
Where they need the most support: ${support}
Investment thinking: ${v.investment || "n/a"}
Prior agency experience: ${v.agencyBefore || "n/a"}

Timing
Decision-making stage: ${v.decisionStage}`.trim();
}

// ─── Choice groups ────────────────────────────────────────────────────────
function CheckboxGroup({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const toggle = (opt: string) =>
    onChange(value.includes(opt) ? value.filter((v) => v !== opt) : [...value, opt]);
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {options.map((opt) => (
        <label
          key={opt}
          className={`flex items-center gap-2.5 rounded-[4px] border px-3 py-2.5 text-sm cursor-pointer transition-colors
            ${value.includes(opt)
              ? "border-[#0000FF] bg-[#0000FF]/10 text-white font-medium"
              : "border-[#333] bg-black text-[#999999] hover:border-[#0000FF] hover:text-white"}`}
        >
          <input
            type="checkbox"
            className="accent-primary shrink-0"
            checked={value.includes(opt)}
            onChange={() => toggle(opt)}
          />
          {opt}
        </label>
      ))}
    </div>
  );
}

function RadioGroup({
  options,
  value,
  onChange,
  columns = 2,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
  columns?: 1 | 2;
}) {
  return (
    <div className={`grid grid-cols-1 ${columns === 2 ? "sm:grid-cols-2" : ""} gap-2`}>
      {options.map((opt) => (
        <label
          key={opt}
          className={`flex items-center gap-2.5 rounded-[4px] border px-3 py-2.5 text-sm cursor-pointer transition-colors
            ${value === opt
              ? "border-[#0000FF] bg-[#0000FF]/10 text-white font-medium"
              : "border-[#333] bg-black text-[#999999] hover:border-[#0000FF] hover:text-white"}`}
        >
          <input
            type="radio"
            className="accent-primary shrink-0"
            checked={value === opt}
            onChange={() => onChange(opt)}
          />
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

function SectionHeader({ kicker, title, subtitle }: { kicker: string; title: string; subtitle?: string }) {
  return (
    <div className="px-6 py-4 border-b border-[#222] bg-[#111]">
      <div className="text-[11px] tracking-[0.15em] text-[#999999] mb-1">{kicker}</div>
      <h2 className="font-semibold text-foreground">{title}</h2>
      {subtitle && <p className="text-sm text-muted-foreground mt-0.5">{subtitle}</p>}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────
export default function Intake() {
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const intake = useForm<IntakeValues>({
    resolver: zodResolver(intakeSchema),
    defaultValues: {
      firstName: "",
      lastName: "",
      jobTitle: "",
      email: "",
      phone: "",
      preferredContact: "",
      hearAbout: "",
      hearAboutOther: "",
      orgName: "",
      website: "",
      industry: "",
      industryOther: "",
      market: "",
      marketOther: "",
      problems: [],
      problemsOther: "",
      support: [],
      supportOther: "",
      investment: "",
      agencyBefore: "",
      decisionStage: "",
    },
  });

  const { errors } = intake.formState;
  const hearAbout = intake.watch("hearAbout");
  const industry = intake.watch("industry");
  const market = intake.watch("market");
  const problems = intake.watch("problems");
  const support = intake.watch("support");

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
      setSubmitError(
        "We couldn't submit your form. Please check your connection and try again.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-black text-white">
      {/* Top bar */}
      <header className="bg-black border-b border-[#222]">
        <div className="max-w-3xl mx-auto px-6 py-4">
          <img src="/onwrd-logo-white.png" alt="ONWRD" className="h-7 object-contain object-left" />
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-12">
        {submitted ? (
          /* ── Thank-you screen ── */
          <div className="bg-black border border-[#222] rounded-[4px] p-12 text-center space-y-4">
            <div className="mx-auto w-14 h-14 rounded-full bg-[#111] flex items-center justify-center">
              <CheckCircle className="w-7 h-7" style={{ color: "#00FFD5" }} />
            </div>
            <h1 className="text-2xl font-bold text-white">Thank you.</h1>
            <p className="text-muted-foreground max-w-md mx-auto leading-relaxed">
              We look forward to learning more about your organization and will be in
              touch within two business days. In the meantime, learn more about who we
              are and how we think at onwrdadvisors.com.
            </p>
          </div>
        ) : (
          <>
            {/* ── Intro ── */}
            <div className="mb-10">
              <div className="text-[11px] tracking-[0.15em] text-[#999999] mb-2">
                PROPOSAL INTAKE FORM
              </div>
              <h1 className="text-3xl font-bold text-white mb-3 tracking-tight">
                Tell us about your organization
              </h1>
              <p className="text-muted-foreground leading-relaxed max-w-xl">
                This form helps us shape a proposal specific to your situation. Your
                information is treated with full confidentiality and used only to
                prepare your proposal.
              </p>
            </div>

            <form
              onSubmit={intake.handleSubmit(handleSubmit)}
              className="space-y-6"
              noValidate
            >
              {/* ── 01 · Let's start with you ── */}
              <section className="bg-black border border-[#222] rounded-[4px] overflow-hidden">
                <SectionHeader kicker="01" title="Let's start with you" />
                <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-5">
                  <div>
                    <Label htmlFor="firstName" className="mb-1.5 block">
                      First Name <span className="text-destructive">*</span>
                    </Label>
                    <Input id="firstName" {...intake.register("firstName")} />
                    <FieldError msg={errors.firstName?.message} />
                  </div>
                  <div>
                    <Label htmlFor="lastName" className="mb-1.5 block">
                      Last Name <span className="text-destructive">*</span>
                    </Label>
                    <Input id="lastName" {...intake.register("lastName")} />
                    <FieldError msg={errors.lastName?.message} />
                  </div>
                  <div>
                    <Label htmlFor="jobTitle" className="mb-1.5 block">
                      Job Title <span className="text-destructive">*</span>
                    </Label>
                    <Input id="jobTitle" {...intake.register("jobTitle")} />
                    <FieldError msg={errors.jobTitle?.message} />
                  </div>
                  <div>
                    <Label htmlFor="email" className="mb-1.5 block">
                      Email Address <span className="text-destructive">*</span>
                    </Label>
                    <Input id="email" type="email" {...intake.register("email")} />
                    <FieldError msg={errors.email?.message} />
                  </div>
                  <div>
                    <Label htmlFor="phone" className="mb-1.5 block">
                      Phone Number <span className="text-muted-foreground text-xs">(optional)</span>
                    </Label>
                    <Input id="phone" {...intake.register("phone")} />
                  </div>
                  <div>
                    <Label className="mb-2 block">
                      Preferred Contact Method{" "}
                      <span className="text-muted-foreground text-xs">(optional)</span>
                    </Label>
                    <Controller
                      control={intake.control}
                      name="preferredContact"
                      render={({ field }) => (
                        <RadioGroup
                          options={CONTACT_OPTIONS}
                          value={field.value ?? ""}
                          onChange={field.onChange}
                        />
                      )}
                    />
                  </div>
                  <div className="md:col-span-2">
                    <Label className="mb-2 block">
                      How did you hear about ONWRD?{" "}
                      <span className="text-destructive">*</span>
                    </Label>
                    <Controller
                      control={intake.control}
                      name="hearAbout"
                      render={({ field }) => (
                        <RadioGroup
                          options={HEAR_OPTIONS}
                          value={field.value}
                          onChange={field.onChange}
                        />
                      )}
                    />
                    <FieldError msg={errors.hearAbout?.message} />
                    {hearAbout === "Other" && (
                      <>
                        <Input
                          className="mt-2"
                          placeholder="Please specify..."
                          {...intake.register("hearAboutOther")}
                        />
                        <FieldError msg={errors.hearAboutOther?.message} />
                      </>
                    )}
                  </div>
                </div>
              </section>

              {/* ── 02 · Your organization ── */}
              <section className="bg-black border border-[#222] rounded-[4px] overflow-hidden">
                <SectionHeader kicker="02" title="Your organization" />
                <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-5">
                  <div>
                    <Label htmlFor="orgName" className="mb-1.5 block">
                      Organization Name <span className="text-destructive">*</span>
                    </Label>
                    <Input id="orgName" {...intake.register("orgName")} />
                    <FieldError msg={errors.orgName?.message} />
                  </div>
                  <div>
                    <Label htmlFor="website" className="mb-1.5 block">
                      Website <span className="text-muted-foreground text-xs">(optional)</span>
                    </Label>
                    <Input id="website" placeholder="https://yourwebsite.com" {...intake.register("website")} />
                  </div>
                  <div className="md:col-span-2">
                    <Label className="mb-2 block">
                      Industry / Service Category <span className="text-destructive">*</span>
                    </Label>
                    <Controller
                      control={intake.control}
                      name="industry"
                      render={({ field }) => (
                        <RadioGroup
                          options={INDUSTRY_OPTIONS}
                          value={field.value}
                          onChange={field.onChange}
                        />
                      )}
                    />
                    <FieldError msg={errors.industry?.message} />
                    {industry === "Other" && (
                      <>
                        <Input
                          className="mt-2"
                          placeholder="Please specify..."
                          {...intake.register("industryOther")}
                        />
                        <FieldError msg={errors.industryOther?.message} />
                      </>
                    )}
                  </div>
                  <div className="md:col-span-2">
                    <Label className="mb-2 block">
                      Primary Market / Geography <span className="text-destructive">*</span>
                    </Label>
                    <Controller
                      control={intake.control}
                      name="market"
                      render={({ field }) => (
                        <RadioGroup
                          options={MARKET_OPTIONS}
                          value={field.value}
                          onChange={field.onChange}
                        />
                      )}
                    />
                    <FieldError msg={errors.market?.message} />
                    {market === "Other" && (
                      <>
                        <Input
                          className="mt-2"
                          placeholder="Please specify..."
                          {...intake.register("marketOther")}
                        />
                        <FieldError msg={errors.marketOther?.message} />
                      </>
                    )}
                  </div>
                </div>
              </section>

              {/* ── 03 · The brief ── */}
              <section className="bg-black border border-[#222] rounded-[4px] overflow-hidden">
                <SectionHeader kicker="03" title="The brief" />
                <div className="p-6 space-y-6">
                  <div>
                    <Label className="mb-2 block">
                      What is the problem you're trying to solve?{" "}
                      <span className="text-destructive">*</span>
                      <span className="text-muted-foreground text-xs ml-1">(select all that apply)</span>
                    </Label>
                    <Controller
                      control={intake.control}
                      name="problems"
                      render={({ field }) => (
                        <CheckboxGroup
                          options={PROBLEM_OPTIONS}
                          value={field.value}
                          onChange={field.onChange}
                        />
                      )}
                    />
                    <FieldError msg={errors.problems?.message} />
                    {problems.includes("Other") && (
                      <>
                        <Input
                          className="mt-2"
                          placeholder="Please specify..."
                          {...intake.register("problemsOther")}
                        />
                        <FieldError msg={errors.problemsOther?.message} />
                      </>
                    )}
                  </div>

                  <div>
                    <Label className="mb-2 block">
                      Where do you need the most support right now?{" "}
                      <span className="text-destructive">*</span>
                      <span className="text-muted-foreground text-xs ml-1">(select all that apply)</span>
                    </Label>
                    <Controller
                      control={intake.control}
                      name="support"
                      render={({ field }) => (
                        <CheckboxGroup
                          options={SUPPORT_OPTIONS}
                          value={field.value}
                          onChange={field.onChange}
                        />
                      )}
                    />
                    <FieldError msg={errors.support?.message} />
                    {support.includes("Other") && (
                      <>
                        <Input
                          className="mt-2"
                          placeholder="Please specify..."
                          {...intake.register("supportOther")}
                        />
                        <FieldError msg={errors.supportOther?.message} />
                      </>
                    )}
                  </div>

                  <div>
                    <Label className="mb-2 block">
                      How are you thinking about investment?{" "}
                      <span className="text-muted-foreground text-xs">(optional)</span>
                    </Label>
                    <Controller
                      control={intake.control}
                      name="investment"
                      render={({ field }) => (
                        <RadioGroup
                          options={INVESTMENT_OPTIONS}
                          value={field.value ?? ""}
                          onChange={field.onChange}
                          columns={1}
                        />
                      )}
                    />
                  </div>

                  <div>
                    <Label className="mb-2 block">
                      Have you worked with a marketing agency before?{" "}
                      <span className="text-muted-foreground text-xs">(optional)</span>
                    </Label>
                    <Controller
                      control={intake.control}
                      name="agencyBefore"
                      render={({ field }) => (
                        <RadioGroup
                          options={AGENCY_OPTIONS}
                          value={field.value ?? ""}
                          onChange={field.onChange}
                        />
                      )}
                    />
                  </div>
                </div>
              </section>

              {/* ── 06 · Timing ── */}
              <section className="bg-black border border-[#222] rounded-[4px] overflow-hidden">
                <SectionHeader kicker="06" title="Timing" />
                <div className="p-6">
                  <Label className="mb-2 block">
                    Where are you in your decision-making?{" "}
                    <span className="text-destructive">*</span>
                  </Label>
                  <Controller
                    control={intake.control}
                    name="decisionStage"
                    render={({ field }) => (
                      <RadioGroup
                        options={DECISION_OPTIONS}
                        value={field.value}
                        onChange={field.onChange}
                        columns={1}
                      />
                    )}
                  />
                  <FieldError msg={errors.decisionStage?.message} />
                </div>
              </section>

              {submitError && (
                <p className="text-sm text-destructive text-right">{submitError}</p>
              )}
              <div className="flex justify-end pt-2">
                <Button type="submit" size="lg" className="min-w-32" disabled={submitting}>
                  {submitting ? "Submitting…" : "Submit"}
                </Button>
              </div>
            </form>
          </>
        )}
      </main>

      {/* Footer */}
      <footer className="text-center text-xs text-muted-foreground py-8">
        ONWRD Advisors · Nassau, The Bahamas · onwrdadvisors.com
      </footer>
    </div>
  );
}
