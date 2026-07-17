import { Router } from "express";
import multer from "multer";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import { db } from "@workspace/db";
import { proposalsTable, intakeDraftsTable } from "@workspace/db";
import { eq, and, lt } from "drizzle-orm";
import { openai, AI_MODEL } from "@workspace/integrations-openai-ai-server";
import { Resend } from "resend";
import { ONWRD_CASE_STUDIES } from "../lib/onwrd-case-studies.js";
import {
  ParseBriefBody,
  CreateProposalBody,
  UpdateProposalBody,
  GetProposalParams,
  UpdateProposalParams,
  DeleteProposalParams,
  ExportToGoogleDocsParams,
} from "@workspace/api-zod";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/plain"].includes(file.mimetype)
      || file.originalname.match(/\.(pdf|docx|txt)$/i);
    cb(null, !!ok);
  },
});

const router = Router();

/** Send an email to ONWRD when a new intake form is submitted. */
async function sendIntakeNotification(
  clientName: string,
  industry: string,
  proposalId: number,
  googleDocUrl: string | null,
) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[intake] RESEND_API_KEY not set — skipping notification email");
    return;
  }

  const from = process.env.RESEND_FROM ?? "ONWRD Proposal Desk <desk@onwrdadvisors.com>";
  const to = ["j.aymes@onwrdadvisors.com", "s.esmeralda@onwrdadvisors.com"];

  const appBase = process.env.APP_URL
    ?? (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}/proposal-generator` : "");
  const appUrl = appBase ? `${appBase}/proposals/${proposalId}` : null;

  const ctaUrl = googleDocUrl ?? appUrl;
  const ctaLabel = googleDocUrl ? "Open in Google Docs →" : "View Draft Proposal →";

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from,
    to,
    subject: `New brief submitted — ${clientName}`,
    html: `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;padding:32px;border-radius:8px">
  <img src="https://onwrdadvisors.com/wp-content/uploads/2024/01/onwrd-logo-white.png" style="height:32px;margin-bottom:24px" alt="ONWRD"/>
  <h2 style="color:#fff;margin:0 0 4px">New client brief received</h2>
  <p style="color:#888;margin:0 0 24px">${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</p>
  <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:24px">
    <tr><td style="color:#555;padding:6px 0;width:120px">Client</td><td style="color:#fff;font-weight:600">${clientName}</td></tr>
    <tr><td style="color:#555;padding:6px 0">Industry</td><td style="color:#fff">${industry}</td></tr>
    <tr><td style="color:#555;padding:6px 0">Proposal ID</td><td style="color:#fff">#${proposalId}</td></tr>
    ${googleDocUrl ? `<tr><td style="color:#555;padding:6px 0">Google Doc</td><td><a href="${googleDocUrl}" style="color:#4ade80;font-size:12px;word-break:break-all">${googleDocUrl}</a></td></tr>` : ""}
  </table>
  <p style="color:#888;font-size:14px;margin-bottom:20px">A draft proposal has been generated and is ready for your review.</p>
  ${ctaUrl ? `<a href="${ctaUrl}" style="display:inline-block;background:#fff;color:#000;font-weight:600;font-size:14px;padding:12px 28px;border-radius:6px;text-decoration:none">${ctaLabel}</a>` : ""}
  ${googleDocUrl && appUrl ? `<p style="margin-top:12px;font-size:12px;color:#555">Also available in the app: <a href="${appUrl}" style="color:#555">${appUrl}</a></p>` : ""}
  <p style="margin-top:32px;color:#333;font-size:12px">ONWRD Proposal Desk — automated proposal generation</p>
</div>`,
  });

  if (error) {
    console.error("[intake] Resend error:", error);
  } else {
    console.log(`[intake] Notification sent to ${to.join(", ")}${googleDocUrl ? " with Google Doc link" : ""}`);
  }
}

const PROPOSAL_TEMPLATE = `ONWRD PROJECT PROPOSAL

Project: {clientName}
Prepared for: {clientContact}
Prepared by: ONWRD
Date: {date}
Proposal version: 1.0

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CONTENTS

1. Executive Summary
2. Client Context and Problem Definition
3. Goals, KPIs and Success Criteria
4. Recommended Strategic Approach
5. Detailed Scope of Work
6. Deliverables Register
7. Timeline, Milestones and Dependencies
8. Team Structure and Ways of Working
9. Investment and Commercial Terms
10. Assumptions, Exclusions and Risks
11. Governance, Approval and Change Control
12. Why ONWRD
13. Case Studies and Credentials
14. Legal and Operational Terms
15. Next Steps and Acceptance

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. EXECUTIVE SUMMARY

The challenge: {challenge}

The opportunity: {opportunity}

The goal: To drive growth within the {industry} sector by addressing primary objectives: {objectives}.

The recommendation: {recommendation}

The investment snapshot: {investmentSnapshot}

The decision required: {decisionRequired}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

2. CLIENT CONTEXT AND PROBLEM DEFINITION

2.1 Business Context

{businessContext}

2.2 Current-State Assessment

{currentStateAssessment}

2.3 Problem Definition

{problemDefinition}

2.4 Opportunity Statement

{opportunityStatement}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

3. GOALS, KPIs AND SUCCESS CRITERIA

3.1 Objectives Ladder

Business objective(s): {businessObjectives}

Marketing objective(s): {marketingObjectives}

User / customer objective(s): {userObjectives}

Operational objective(s): {operationalObjectives}

3.2 KPI Framework

{kpiFramework}

3.3 Definition of Success

{definitionOfSuccess}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

4. RECOMMENDED STRATEGIC APPROACH

4.1 Strategic Thesis

{strategicThesis}

4.2 Core Pillars

Discovery & Strategy: {discoveryStrategyPillar}

Creative Execution: {creativeExecutionPillar}

Technical Foundation: {technicalFoundationPillar}

Optimization Layer: {optimizationPillar}

4.3 Guiding Principles

{guidingPrinciples}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

5. DETAILED SCOPE OF WORK

5.1 Phase 1 – Discovery, Audit and Strategy

Lead: Project Management & Strategy Lead

Objectives: {phase1Objectives}

In-scope activities: {phase1InScope}

Out-of-scope activities: {phase1OutOfScope}

Deliverables: {phase1Deliverables}

Review rounds: {phase1ReviewRounds}

Dependencies: {phase1Dependencies}

Approval gate: Client sign-off on diagnostic summary and roadmap before Phase 2 begins.

5.2 Phase 2 – Messaging, Content and Creative Direction

Lead: Strategy Lead with Design Team

Objectives: {phase2Objectives}

In-scope activities: {phase2InScope}

Out-of-scope activities: {phase2OutOfScope}

Deliverables: {phase2Deliverables}

Review rounds: {phase2ReviewRounds}

Dependencies: {phase2Dependencies}

Approval gate: Client sign-off on messaging framework and creative direction before Phase 3 begins.

5.3 Phase 3 – Design System and Asset Production

Lead: Design Team

Objectives: {phase3Objectives}

In-scope activities: {phase3InScope}

Out-of-scope activities: {phase3OutOfScope}

Deliverables: {phase3Deliverables}

Review rounds: {phase3ReviewRounds}

Dependencies: {phase3Dependencies}

Approval gate: Client sign-off on final design files before Phase 4 begins.

5.4 Phase 4 – Website / Landing Page / Technical Implementation

Lead: Web Development Team

Objectives: {phase4Objectives}

In-scope activities: {phase4InScope}

Out-of-scope activities: {phase4OutOfScope}

Deliverables: {phase4Deliverables}

Review rounds: {phase4ReviewRounds}

Dependencies: {phase4Dependencies}

Approval gate: Client QA sign-off on staging before go-live.

5.5 Phase 5 – Launch, Enablement and Optimization

Lead: Cross-functional pod

Objectives: {phase5Objectives}

In-scope activities: {phase5InScope}

Deliverables: {phase5Deliverables}

Dependencies: {phase5Dependencies}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

6. DELIVERABLES REGISTER

{deliverablesRegister}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

7. TIMELINE, MILESTONES AND DEPENDENCIES

7.1 Timeline Logic

{timelineLogic}

7.2 Milestones

Proposal submission (ONWRD → Client): {proposalDate}
Requested information due (Client → ONWRD): {infoDate}
Kickoff: {kickoffDate} — Dependency: Signed approval + deposit + platform access
Midpoint review: {midpointDate} — Dependency: Phase completions
Final approval / launch: {launchDate} — Dependency: QA sign-off

7.3 Dependency Checklist

{dependencyChecklist}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

8. TEAM STRUCTURE AND WAYS OF WORKING

8.1 Proposed Team

Engagement Lead — Owns relationship, scope, quality, and escalation. Weekly / milestone-based involvement.
Strategy Lead — Drives diagnosis, recommendations, and narrative clarity. Front-loaded + key reviews.
Design Lead — Owns visual direction and asset quality. During concept and production phases.
Developer / Technical Lead — Owns implementation, QA, and launch readiness. During build and QA phases.
Project Coordinator — Tracks timeline, tasks, approvals, and file hygiene. As needed.

8.2 Working Model

{workingModel}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

9. INVESTMENT AND COMMERCIAL TERMS

9.1 Recommended Pricing Structure

{pricingStructure}

9.2 Investment Table

Strategy & Management | {strategyHours} hrs | {strategyCost}
Design & Creative | {designHours} hrs | {designCost}
Web Development / Implementation | {devHours} hrs | {devCost}
Optional Optimization / Support | {optHours} hrs | {optCost}
─────────────────────────────────────────────────────
Project Total | {totalHours} hrs | {totalCost}

9.3 Payment Terms

{paymentTerms}

9.4 Optional Add-Ons

{optionalAddOns}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

10. ASSUMPTIONS, EXCLUSIONS AND RISKS

10.1 Assumptions

{assumptions}

10.2 Exclusions

{exclusions}

10.3 Risks and Mitigation

{risksAndMitigation}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

11. GOVERNANCE, APPROVAL AND CHANGE CONTROL

11.1 Governance Model

{governanceModel}

11.2 Approval Process

{approvalProcess}

11.3 Change Requests

{changeRequests}

11.4 Quality Assurance

{qualityAssurance}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

12. WHY ONWRD

Integrated pods rather than isolated freelancers or disconnected departments — strategy, design, and development moving as one unit.

Strategic clarity carried through design and implementation, reducing translation loss between brief and final output.

Senior oversight where judgment matters, with specialized execution where depth matters.

Practical, commercially aware recommendations rather than abstract brand theatre.

Comfort operating across strategy, content, design, web, and launch execution — from first brief to live site.

{whyOnwrdCustom}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

13. CASE STUDIES AND CREDENTIALS

{caseStudies}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

14. LEGAL AND OPERATIONAL TERMS

14.1 Confidentiality
Both parties agree to treat all shared materials, data, and strategic information as confidential. Client data, platform access, and sensitive materials will be handled with appropriate discretion and not shared with third parties.

14.2 Intellectual Property
ONWRD retains all work product until final payment is received. Upon full payment, all approved deliverables transfer to the client. Source files, licensed assets, and third-party tools are subject to their respective license terms.

14.3 Term and Termination
{termAndTermination}

14.4 Warranty / Liability
ONWRD commits to delivering work to a professional standard consistent with the approved brief and scope. Liability is limited to the value of fees paid for the relevant phase of work.

14.5 Proposal Validity
This proposal and associated pricing remain valid for 30 days from the date of issue, after which a re-quote may be required.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

15. NEXT STEPS AND ACCEPTANCE

Step 1: Review proposal and confirm scope direction.
Step 2: Resolve commercial questions and optional add-ons.
Step 3: Approve proposal and issue deposit / purchase order if required.
Step 4: Share platform access, source files, and stakeholder list.
Step 5: Schedule kickoff call.

Client approval: _____________________________ Date: ___________
ONWRD signatory: ____________________________ Date: ___________`;


function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function formatDate(date: Date): string {
  return date.toISOString().split("T")[0];
}

router.get("/proposals", async (req, res) => {
  try {
    const proposals = await db
      .select()
      .from(proposalsTable)
      .orderBy(proposalsTable.createdAt);
    res.json(proposals);
  } catch (err) {
    req.log.error({ err }, "Error listing proposals");
    res.status(500).json({ error: "Failed to list proposals" });
  }
});

router.post("/proposals", async (req, res) => {
  const parsed = CreateProposalBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  try {
    const [proposal] = await db
      .insert(proposalsTable)
      .values({
        clientName: parsed.data.clientName,
        industry: parsed.data.industry,
        briefText: parsed.data.briefText,
        proposalContent: parsed.data.proposalContent,
        status: "draft",
      })
      .returning();
    res.status(201).json(proposal);
  } catch (err) {
    req.log.error({ err }, "Error creating proposal");
    res.status(500).json({ error: "Failed to create proposal" });
  }
});

router.get("/proposals/:id", async (req, res) => {
  const parsed = GetProposalParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  try {
    const [proposal] = await db
      .select()
      .from(proposalsTable)
      .where(eq(proposalsTable.id, parsed.data.id));

    if (!proposal) {
      res.status(404).json({ error: "Proposal not found" });
      return;
    }

    res.json(proposal);
  } catch (err) {
    req.log.error({ err }, "Error fetching proposal");
    res.status(500).json({ error: "Failed to fetch proposal" });
  }
});

router.put("/proposals/:id", async (req, res) => {
  const paramParsed = UpdateProposalParams.safeParse({
    id: Number(req.params.id),
  });
  if (!paramParsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const bodyParsed = UpdateProposalBody.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  try {
    const updateData: Record<string, unknown> = {
      updatedAt: new Date(),
    };
    if (bodyParsed.data.clientName !== undefined)
      updateData.clientName = bodyParsed.data.clientName;
    if (bodyParsed.data.industry !== undefined)
      updateData.industry = bodyParsed.data.industry;
    if (bodyParsed.data.proposalContent !== undefined)
      updateData.proposalContent = bodyParsed.data.proposalContent;
    if (bodyParsed.data.status !== undefined)
      updateData.status = bodyParsed.data.status;

    const [proposal] = await db
      .update(proposalsTable)
      .set(updateData)
      .where(eq(proposalsTable.id, paramParsed.data.id))
      .returning();

    if (!proposal) {
      res.status(404).json({ error: "Proposal not found" });
      return;
    }

    res.json(proposal);
  } catch (err) {
    req.log.error({ err }, "Error updating proposal");
    res.status(500).json({ error: "Failed to update proposal" });
  }
});

router.delete("/proposals/:id", async (req, res) => {
  const parsed = DeleteProposalParams.safeParse({ id: Number(req.params.id) });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  try {
    const [deleted] = await db
      .delete(proposalsTable)
      .where(eq(proposalsTable.id, parsed.data.id))
      .returning();

    if (!deleted) {
      res.status(404).json({ error: "Proposal not found" });
      return;
    }

    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "Error deleting proposal");
    res.status(500).json({ error: "Failed to delete proposal" });
  }
});

/**
 * Extract plain text from an uploaded PDF, DOCX, or TXT file.
 * Used by the New Proposal page so the user can upload a document
 * instead of typing a brief.
 */
router.post("/proposals/extract-text", upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded." });
    return;
  }
  const { mimetype, originalname, buffer } = req.file;
  try {
    let text = "";
    if (mimetype === "application/pdf" || originalname.match(/\.pdf$/i)) {
      const result = await pdfParse(buffer);
      text = result.text?.trim() ?? "";
      if (!text) {
        res.status(400).json({ error: "The PDF has no selectable text — try copying the content manually." });
        return;
      }
    } else if (mimetype.includes("wordprocessingml") || originalname.match(/\.docx$/i)) {
      const result = await mammoth.extractRawText({ buffer });
      text = result.value?.trim() ?? "";
    } else {
      text = buffer.toString("utf-8").trim();
    }
    res.json({ text });
  } catch (err) {
    req.log.error({ err }, "extract-text failed");
    res.status(500).json({ error: "Could not extract text from the file." });
  }
});

router.post("/proposals/parse-brief", async (req, res) => {
  const parsed = ParseBriefBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const { briefText } = parsed.data;
  const now = new Date();

  try {
    const completion = await openai.chat.completions.create({
      model: AI_MODEL,
      max_tokens: 16000,
      messages: [
        {
          role: "system",
          content: `You are a senior proposal writer at ONWRD, a full-service marketing agency. You write precise, persuasive, senior-quality proposals.

Given a project brief, extract all relevant information and produce a comprehensive, fully-populated proposal document. Every section must be written with real, specific, substantive content — not placeholders, not vague generalities.

RULES:
- Replace every {placeholder} in the template with fully written content drawn from the brief. Infer intelligently where the brief is silent.
- Write in a confident, direct agency voice. No filler. No waffle. No generic statements.
- Every section must be complete paragraphs or well-structured lists — never one-liners.
- The KPI Framework (section 3.2) must include at least 4 rows with realistic metrics, baselines, and targets.
- The Deliverables Register (section 6) must list at least 6 deliverables with purpose, owner, format, and review notes.
- The Investment Table must include estimated hour ranges and realistic USD figures scaled to the scope.
- Risks and Mitigation must include at least 4 risks.
- Case Studies section MUST draw from the real ONWRD past work supplied below — do NOT invent client names, projects, or outcomes.
- Dates to use: Today = ${formatDate(now)} | Proposal due = ${formatDate(addDays(now, 10))} | Info due from client = ${formatDate(addDays(now, 7))} | Kickoff = infer from brief or use ${formatDate(addDays(now, 21))} | Midpoint = infer | Launch = infer.

${ONWRD_CASE_STUDIES}

TEMPLATE TO POPULATE:

${PROPOSAL_TEMPLATE}

Return your response as JSON with exactly these fields:
{
  "clientName": "string (organization name from brief)",
  "industry": "string (sector/industry)",
  "proposalContent": "string (the complete populated proposal, preserving all section headers, dividers, and structure)"
}`,
        },
        {
          role: "user",
          content: `Here is the project brief:\n\n${briefText}`,
        },
      ],
    });

    const content = completion.choices[0]?.message?.content ?? "";

    let result: {
      clientName: string;
      industry: string;
      proposalContent: string;
    };
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        result = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error("No JSON found in response");
      }
    } catch {
      result = {
        clientName: "Unknown Client",
        industry: "General",
        proposalContent: content,
      };
    }

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Error parsing brief");
    res.status(500).json({ error: "Failed to parse brief with AI" });
  }
});

/**
 * Autosave draft — upserts contact-details for a partially completed intake form.
 * Keyed by email + status="draft" so repeated autosaves update the same row.
 */
router.post("/intake/draft", async (req, res) => {
  const { firstName, lastName, jobTitle, email, phone, preferredContact } = req.body as {
    firstName?: string; lastName?: string; jobTitle?: string; email?: string;
    phone?: string; preferredContact?: string;
  };

  if (!firstName?.trim() || !lastName?.trim() || !jobTitle?.trim() || !email?.trim()) {
    res.status(400).json({ error: "firstName, lastName, jobTitle and email are required" });
    return;
  }

  try {
    const [existing] = await db
      .select({ id: intakeDraftsTable.id })
      .from(intakeDraftsTable)
      .where(and(eq(intakeDraftsTable.email, email.trim()), eq(intakeDraftsTable.status, "draft")))
      .limit(1);

    if (existing) {
      await db
        .update(intakeDraftsTable)
        .set({ firstName: firstName.trim(), lastName: lastName.trim(), jobTitle: jobTitle.trim(), phone: phone ?? null, preferredContact: preferredContact ?? null, updatedAt: new Date() })
        .where(eq(intakeDraftsTable.id, existing.id));
      res.json({ id: existing.id });
    } else {
      const [draft] = await db
        .insert(intakeDraftsTable)
        .values({ firstName: firstName.trim(), lastName: lastName.trim(), jobTitle: jobTitle.trim(), email: email.trim(), phone: phone ?? null, preferredContact: preferredContact ?? null })
        .returning({ id: intakeDraftsTable.id });
      res.json({ id: draft.id });
    }
  } catch (err) {
    req.log.error({ err }, "Error saving intake draft");
    res.status(500).json({ error: "Failed to save draft" });
  }
});

/**
 * Public intake endpoint — generates + saves a proposal silently (status: "new"),
 * returns only { success: true } so the draft is never exposed to the client.
 * Accepts multipart/form-data (with optional briefFile) or application/json.
 */
router.post("/intake", upload.single("briefFile"), async (req, res) => {
  const briefText: string = req.body?.briefText ?? "";
  const clientName: string = req.body?.clientName ?? "";
  const industry: string = req.body?.industry ?? "";
  const draftId: number | undefined = req.body?.draftId ? Number(req.body.draftId) : undefined;

  // Parse uploaded file text if present
  let fileText = "";
  if (req.file) {
    try {
      const { mimetype, originalname, buffer } = req.file;
      if (mimetype === "application/pdf" || originalname.match(/\.pdf$/i)) {
        const result = await pdfParse(buffer);
        fileText = result.text?.trim() ?? "";
        if (!fileText) {
          res.status(400).json({ error: "The uploaded PDF has no selectable text. Please copy-paste the content into the brief field instead." });
          return;
        }
      } else if (mimetype.includes("wordprocessingml") || originalname.match(/\.docx$/i)) {
        const result = await mammoth.extractRawText({ buffer });
        fileText = result.value?.trim() ?? "";
      } else {
        fileText = buffer.toString("utf-8").trim();
      }
    } catch (err) {
      req.log.warn({ err }, "File parsing failed — proceeding with briefText only");
    }
  }

  // Merge briefText and fileText
  const combinedBrief = [briefText, fileText].filter(Boolean).join("\n\n--- Uploaded Document ---\n\n");

  if (!combinedBrief || !clientName || !industry) {
    res.status(400).json({ error: "A project brief (typed or uploaded), clientName and industry are required" });
    return;
  }

  try {
    const now = new Date();
    const intakeSystemPrompt = `You are a senior proposal writer at ONWRD, a full-service marketing agency. You write precise, persuasive, senior-quality proposals.

Given a project brief, extract all relevant information and produce a comprehensive, fully-populated proposal document. Every section must be written with real, specific, substantive content — not placeholders, not vague generalities.

RULES:
- Replace every {placeholder} in the template with fully written content drawn from the brief. Infer intelligently where the brief is silent.
- Write in a confident, direct agency voice. No filler. No waffle. No generic statements.
- Every section must be complete paragraphs or well-structured lists — never one-liners.
- The KPI Framework (section 3.2) must include at least 4 rows with realistic metrics, baselines, and targets.
- The Deliverables Register (section 6) must list at least 6 deliverables with purpose, owner, format, and review notes.
- The Investment Table must include estimated hour ranges and realistic USD figures scaled to the scope.
- Risks and Mitigation must include at least 4 risks.
- Case Studies section MUST draw from the real ONWRD past work supplied below — do NOT invent client names, projects, or outcomes.
- Dates to use: Today = ${formatDate(now)} | Proposal due = ${formatDate(addDays(now, 10))} | Info due from client = ${formatDate(addDays(now, 7))} | Kickoff = infer from brief or use ${formatDate(addDays(now, 21))} | Midpoint = infer | Launch = infer.

${ONWRD_CASE_STUDIES}

TEMPLATE TO POPULATE:

${PROPOSAL_TEMPLATE}

Return ONLY the completed proposal text — no JSON wrapper, no commentary.`;

    let completion: Awaited<ReturnType<typeof openai.chat.completions.create>> | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        completion = await openai.chat.completions.create({
          model: AI_MODEL,
          messages: [
            { role: "system", content: intakeSystemPrompt },
            { role: "user", content: `Here is the project brief:\n\n${combinedBrief}` },
          ],
          max_tokens: 16000,
        });
        break;
      } catch (err) {
        const isRateLimit = (err as { status?: number })?.status === 429;
        if (isRateLimit && attempt < 2) {
          const delay = (attempt + 1) * 3000;
          console.warn(`[intake] AI rate limit hit, retrying in ${delay}ms (attempt ${attempt + 1})`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }

    const content = completion.choices[0]?.message?.content ?? "";

    const [saved] = await db
      .insert(proposalsTable)
      .values({
        clientName,
        industry,
        briefText: combinedBrief,
        proposalContent: content,
        status: "new",
      })
      .returning();

    // Mark the autosaved draft as converted so it doesn't get flagged as abandoned
    if (draftId && !Number.isNaN(draftId)) {
      db.update(intakeDraftsTable)
        .set({ status: "converted", proposalId: saved.id, updatedAt: new Date() })
        .where(eq(intakeDraftsTable.id, draftId))
        .catch(() => { /* non-critical */ });
    }

    // Respond immediately — client doesn't need to wait for export or email
    res.json({ success: true });

    // Fire-and-forget: export to Google Docs, then notify with the doc link
    (async () => {
      let googleDocUrl: string | null = null;
      try {
        const { createGoogleDoc, appendContentWithLogo, shareWithAnyone } = await import("../lib/google-docs.js");
        const title = `ONWRD Proposal — ${clientName}`;
        const doc = await createGoogleDoc(title);
        const docId = doc.documentId;
        googleDocUrl = `https://docs.google.com/document/d/${docId}/edit`;
        await appendContentWithLogo(docId, content);
        await shareWithAnyone(docId);
        await db
          .update(proposalsTable)
          .set({ googleDocUrl, status: "exported", updatedAt: new Date() })
          .where(eq(proposalsTable.id, saved.id));
        console.log(`[intake] Google Doc created: ${googleDocUrl}`);
      } catch (err) {
        console.error("[intake] Google Docs export failed — will notify with app link:", err);
      }
      sendIntakeNotification(clientName, industry, saved.id, googleDocUrl).catch((err) =>
        console.error("[intake] Email notification failed:", err),
      );
    })();
  } catch (err) {
    req.log.error({ err }, "Error processing intake submission");
    const status = (err as { status?: number })?.status;
    if (status === 429) {
      res.status(503).json({ error: "Our proposal engine is briefly overloaded — please wait 30 seconds and try again." });
    } else {
      res.status(500).json({ error: "Failed to process submission. Please try again." });
    }
  }
});

router.post("/proposals/:id/export-to-google-docs", async (req, res) => {
  const parsed = ExportToGoogleDocsParams.safeParse({
    id: Number(req.params.id),
  });
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  try {
    const [proposal] = await db
      .select()
      .from(proposalsTable)
      .where(eq(proposalsTable.id, parsed.data.id));

    if (!proposal) {
      res.status(404).json({ error: "Proposal not found" });
      return;
    }

    const { createGoogleDoc, appendContentWithLogo, shareWithAnyone } = await import("../lib/google-docs.js");

    const userAccessToken = req.session.googleAccessToken ?? undefined;

    const title = `ONWRD Proposal - ${proposal.clientName}`;

    const doc = await createGoogleDoc(title, userAccessToken);
    const docId = doc.documentId;
    const docUrl = `https://docs.google.com/document/d/${docId}/edit`;

    await appendContentWithLogo(docId, proposal.proposalContent, userAccessToken);
    await shareWithAnyone(docId, userAccessToken);

    await db
      .update(proposalsTable)
      .set({ googleDocUrl: docUrl, status: "exported", updatedAt: new Date() })
      .where(eq(proposalsTable.id, parsed.data.id));

    res.json({ docId, docUrl, title });
  } catch (err) {
    req.log.error({ err }, "Error exporting to Google Docs");
    res.status(500).json({ error: "Failed to export to Google Docs" });
  }
});

export default router;
