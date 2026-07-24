import { Router } from "express";
import multer from "multer";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import { db } from "@workspace/db";
import { proposalsTable, intakeDraftsTable, tendersTable } from "@workspace/db";
import { eq, and, lt, sql } from "drizzle-orm";
import { invokeAI } from "../lib/ai-gateway.js";
import { applyDeterministicScore } from "../lib/apply-deterministic-score.js";
import { ONWRD_CASE_STUDIES } from "../lib/onwrd-case-studies.js";
import {
  ParseBriefBody,
  CreateProposalBody,
  UpdateProposalBody,
  GetProposalParams,
  UpdateProposalParams,
  DeleteProposalParams,
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
    if (bodyParsed.data.proposalContent !== undefined) {
      updateData.proposalContent = bodyParsed.data.proposalContent;
      // Mark as having un-synced changes (cleared on successful export/sync)
      updateData.dirtySince = new Date();
    }
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

/**
 * Score a pasted/uploaded brief for completeness.
 * Returns { sufficient, missing, summary } — no DB writes.
 */
router.post("/proposals/check-brief", async (req, res) => {
  const text: string = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text || text.length < 30) {
    res.json({ sufficient: false, missing: ["project description"], summary: "Too short to assess." });
    return;
  }
  try {
    const { content: raw } = await invokeAI({
      feature: "proposal_check",
      messages: [
        {
          role: "system",
          content: `You are a proposal writer's assistant. Assess whether the text contains enough information to write a professional service proposal.
Return ONLY valid JSON with this shape:
{
  "sufficient": boolean,          // true if a solid proposal can be written
  "missing": string[],            // short labels for missing key elements, e.g. ["budget", "timeline"]
  "summary": string               // one sentence assessment (max 20 words)
}
Key elements to check: client/organisation name, project scope or goals, deliverables, timeline or deadline, budget or contract value, any must-have requirements. If at least 3 of these are present the brief is generally sufficient.`,
        },
        { role: "user", content: text.slice(0, 6000) },
      ],
      maxTokens:      300,
      responseFormat: { type: "json_object" },
      operationKey:   "check-brief",
    });
    const parsed = JSON.parse(raw) as { sufficient?: boolean; missing?: string[]; summary?: string };
    res.json({
      sufficient: parsed.sufficient ?? false,
      missing: Array.isArray(parsed.missing) ? parsed.missing : [],
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
    });
  } catch (err) {
    req.log.error({ err }, "check-brief failed");
    res.status(500).json({ error: "Could not assess the brief." });
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
    const { content } = await invokeAI({
      feature: "proposal_generation",
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
      maxTokens:    16000,
      operationKey: "parse-brief",
    });

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
 * Keyed exclusively by submissionKey (UUID generated by the intake form on mount).
 * Email is stored but never used as an identity or idempotency key.
 */
router.post("/intake/draft", async (req, res) => {
  const { submissionKey, firstName, lastName, jobTitle, email, phone, preferredContact } = req.body as {
    submissionKey?: string; firstName?: string; lastName?: string; jobTitle?: string;
    email?: string; phone?: string; preferredContact?: string;
  };

  if (!submissionKey?.trim()) {
    res.status(400).json({ error: "submissionKey is required" });
    return;
  }
  if (!firstName?.trim() || !lastName?.trim() || !jobTitle?.trim() || !email?.trim()) {
    res.status(400).json({ error: "firstName, lastName, jobTitle and email are required" });
    return;
  }

  try {
    const [draft] = await db
      .insert(intakeDraftsTable)
      .values({
        submissionKey: submissionKey.trim(),
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        jobTitle: jobTitle.trim(),
        email: email.trim(),
        phone: phone ?? null,
        preferredContact: preferredContact ?? null,
      })
      .onConflictDoUpdate({
        target: intakeDraftsTable.submissionKey,
        set: {
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          jobTitle: jobTitle.trim(),
          email: email.trim(),
          phone: phone ?? null,
          preferredContact: preferredContact ?? null,
          updatedAt: new Date(),
        },
      })
      .returning({ id: intakeDraftsTable.id });
    res.json({ id: draft.id });
  } catch (err) {
    req.log.error({ err }, "Error saving intake draft");
    res.status(500).json({ error: "Failed to save draft" });
  }
});

/**
 * Public prospect intake submission — transactional, idempotent by submissionKey.
 *
 * Flow:
 * 1. Validate required fields + submissionKey.
 * 2. Inside one transaction:
 *    a. UPSERT intake_draft by submissionKey (sole idempotency key).
 *    b. SELECT FOR UPDATE to lock the draft row.
 *    c. If opportunityId already set → return {success:true} immediately.
 *    d. INSERT canonical Opportunity with sourceType="prospect_intake".
 *    e. applyDeterministicScore(tx, opportunityId) inside transaction.
 *    f. UPDATE draft.opportunityId.
 * 3. Return {success:true}. Never expose IDs or log PII in errors.
 */
router.post("/intake", upload.none(), async (req, res) => {
  const {
    submissionKey, firstName, lastName, jobTitle, email,
    phone, preferredContact, briefText, clientName, industry,
  } = req.body as {
    submissionKey?: string; firstName?: string; lastName?: string;
    jobTitle?: string; email?: string; phone?: string;
    preferredContact?: string; briefText?: string;
    clientName?: string; industry?: string;
  };

  if (!submissionKey?.trim()) {
    res.status(400).json({ error: "submissionKey is required" });
    return;
  }
  if (!firstName?.trim() || !lastName?.trim() || !jobTitle?.trim() || !email?.trim()) {
    res.status(400).json({ error: "firstName, lastName, jobTitle and email are required" });
    return;
  }

  try {
    type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
    await db.transaction(async (tx: DbTx) => {
      // 1. UPSERT draft by submissionKey only
      await tx
        .insert(intakeDraftsTable)
        .values({
          submissionKey: submissionKey.trim(),
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          jobTitle: jobTitle.trim(),
          email: email.trim(),
          phone: phone ?? null,
          preferredContact: preferredContact ?? null,
          status: "submitted",
        })
        .onConflictDoUpdate({
          target: intakeDraftsTable.submissionKey,
          set: {
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            jobTitle: jobTitle.trim(),
            email: email.trim(),
            phone: phone ?? null,
            preferredContact: preferredContact ?? null,
            status: "submitted",
            updatedAt: new Date(),
          },
        });

      // 2. Lock draft row — prevents concurrent submissions from racing
      const lockResult = await tx.execute(
        sql`SELECT id, opportunity_id FROM intake_drafts WHERE submission_key = ${submissionKey.trim()} FOR UPDATE`,
      );
      const draft = lockResult.rows[0] as { id: number; opportunity_id: number | null } | undefined;
      if (!draft) throw new Error("Draft row missing after upsert");

      // 3. Idempotent: already processed by a previous call
      if (draft.opportunity_id !== null) return;

      // 4. Build brief (structured summary, no raw PII in opportunity fields)
      const fullBrief = [
        briefText?.trim() ?? "",
        `---\n${firstName.trim()} ${lastName.trim()} · ${jobTitle.trim()}`,
      ].filter(Boolean).join("\n\n");

      // 5. INSERT canonical Opportunity
      const [opportunity] = await tx
        .insert(tendersTable)
        .values({
          title:       `Prospect Intake — ${firstName.trim()} ${lastName.trim()}`,
          agency:      clientName?.trim() || `${firstName.trim()} ${lastName.trim()}`,
          description: briefText?.trim() || "Prospect intake submission",
          category:    industry?.trim()  || "General",
          rawText:     fullBrief || null,
          sourceType:  "prospect_intake",
          status:      "opportunity_found",
          recommendationScore: 0,
        })
        .returning({ id: tendersTable.id });

      // 6. Deterministic scoring inside the transaction
      await applyDeterministicScore(tx, opportunity.id);

      // 7. Link draft → opportunity
      await tx
        .update(intakeDraftsTable)
        .set({ opportunityId: opportunity.id, updatedAt: new Date() })
        .where(eq(intakeDraftsTable.id, draft.id));
    });

    res.json({ success: true });
  } catch (err) {
    req.log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "Intake submission failed",
    );
    res.status(500).json({ error: "Submission failed. Please try again." });
  }
});


export default router;
