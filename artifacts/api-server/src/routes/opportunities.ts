import { Router } from "express";
import multer from "multer";
import mammoth from "mammoth";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { db } from "@workspace/db";
import {
  tendersTable,
  proposalsTable,
  tenderRequirementsTable,
  bidScoresTable,
  proposalSectionsTable,
  proposalGenerationRunsTable,
  proposalStrategiesTable,
} from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import { openai, AI_MODEL } from "@workspace/integrations-openai-ai-server";
import { ONWRD_CASE_STUDIES } from "../lib/onwrd-case-studies.js";

const router = Router();

const SECTION_DEFINITIONS = [
  { key: "executive_summary", title: "Executive Summary", order: 0 },
  { key: "client_context", title: "Client Context and Problem Definition", order: 1 },
  { key: "goals_kpis", title: "Goals, KPIs and Success Criteria", order: 2 },
  { key: "strategic_approach", title: "Recommended Strategic Approach", order: 3 },
  { key: "scope_of_work", title: "Detailed Scope of Work", order: 4 },
  { key: "deliverables", title: "Deliverables Register", order: 5 },
  { key: "timeline", title: "Timeline, Milestones and Dependencies", order: 6 },
  { key: "team_structure", title: "Team Structure and Ways of Working", order: 7 },
  { key: "investment", title: "Investment and Commercial Terms", order: 8 },
  { key: "assumptions_risks", title: "Assumptions, Exclusions and Risks", order: 9 },
  { key: "governance", title: "Governance, Approval and Change Control", order: 10 },
  { key: "why_onwrd", title: "Why ONWRD", order: 11 },
  { key: "case_studies", title: "Case Studies and Credentials", order: 12 },
  { key: "legal_terms", title: "Legal and Operational Terms", order: 13 },
  { key: "next_steps", title: "Next Steps and Acceptance", order: 14 },
];

// ── Helpers ────────────────────────────────────────────────────────────────

async function runExtractRequirements(tenderId: number) {
  const [tender] = await db.select().from(tendersTable).where(eq(tendersTable.id, tenderId));
  if (!tender) throw new Error("Tender not found");

  const sourceText = tender.rawText || tender.description;

  const completion = await openai.chat.completions.create({
    model: AI_MODEL,
    max_completion_tokens: 4000,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You extract structured requirements from tender/RFP documents. Return JSON with a "requirements" array. Each requirement has:
- requirementText: the specific requirement (string)
- category: one of "technical", "budget", "timeline", "personnel", "certifications", "format", "deliverable", "compliance", "general"
- isMandatory: true if the requirement is mandatory/essential, false if optional/preferred

Extract all distinct, actionable requirements. Be thorough — include submission format requirements, eligibility criteria, deliverable specs, timeline constraints, and any compliance items.`,
      },
      {
        role: "user",
        content: `Extract all requirements from this tender:\n\nTitle: ${tender.title}\nAgency: ${tender.agency}\n\n${sourceText}`,
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  const data = JSON.parse(raw);
  const reqs: { requirementText: string; category: string; isMandatory: boolean }[] = data.requirements ?? [];

  if (reqs.length === 0) return [];

  await db.delete(tenderRequirementsTable).where(eq(tenderRequirementsTable.tenderId, tenderId));

  const inserted = await db
    .insert(tenderRequirementsTable)
    .values(
      reqs.map((r, i) => ({
        tenderId,
        requirementText: r.requirementText,
        category: r.category ?? "general",
        isMandatory: r.isMandatory ?? true,
        isAnswered: false,
        orderIndex: i,
      }))
    )
    .returning();

  await db
    .update(tendersTable)
    .set({ status: "requirements_extracted", requirementsExtractedAt: new Date(), updatedAt: new Date() })
    .where(eq(tendersTable.id, tenderId));

  return inserted;
}

async function runBidScoring(tenderId: number) {
  const [tender] = await db.select().from(tendersTable).where(eq(tendersTable.id, tenderId));
  if (!tender) throw new Error("Tender not found");

  const requirements = await db
    .select()
    .from(tenderRequirementsTable)
    .where(eq(tenderRequirementsTable.tenderId, tenderId))
    .orderBy(tenderRequirementsTable.orderIndex);

  const requirementsSummary = requirements.length > 0
    ? requirements.map((r, i) => `${i + 1}. [${r.category}] ${r.requirementText}${r.isMandatory ? " (MANDATORY)" : ""}`).join("\n")
    : "No requirements extracted yet.";

  const completion = await openai.chat.completions.create({
    model: AI_MODEL,
    max_completion_tokens: 2000,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are a senior business development advisor at ONWRD, a full-service marketing and strategy agency in the Bahamas. You evaluate whether ONWRD should bid on a tender opportunity.

ONWRD's strengths: marketing strategy, brand identity, digital marketing, content development, website design, campaign management, social media, communications strategy. ONWRD works across the Caribbean region, particularly the Bahamas. ONWRD is a mid-size boutique agency — not suitable for very large infrastructure or construction tenders.

CRITICAL FILTER — INDIVIDUAL ROLES:
If the posting is recruiting an individual person for employment (e.g. "Marketing Manager wanted", "we are hiring a Communications Officer", job ads, staff vacancies), it is NOT an opportunity for an agency. Score it fitScore: 0, fitLevel: "no_bid", and include the flag "Individual employment role — not an RFP for agency services". Do not evaluate it further.

Only score opportunities where an organisation is procuring services from a company/agency (RFPs, tenders, requests for proposals, consultancy contracts, service contracts, etc.).

Evaluate the tender and return JSON with:
- fitScore: integer 0-100 (how well ONWRD fits this opportunity)
- fitLevel: "strong" (75-100), "moderate" (50-74), "weak" (25-49), or "no_bid" (0-24)
- reasoning: 2-3 sentence explanation of the score
- flags: array of strings, each a specific concern or positive factor (e.g. "Requires ISO certification ONWRD doesn't hold", "Directly in ONWRD's core discipline", "Deadline is only 7 days away")
- completenessScore: integer 0-100 measuring how much useful information is present to write a strong proposal (100 = clear objectives, full scope, explicit requirements, budget and timeline stated; 0 = vague or near-empty posting)
- missingFields: array of short strings naming critical gaps that would strengthen a proposal response (e.g. "Budget not specified", "Timeline vague", "Evaluation criteria unclear", "Contact details absent"). Empty array if the tender is complete.

${ONWRD_CASE_STUDIES}`,
      },
      {
        role: "user",
        content: `Evaluate this tender for ONWRD:

Title: ${tender.title}
Agency: ${tender.agency}
Category: ${tender.category}
Value: ${tender.valueAmount ?? "Not specified"}
Deadline: ${tender.deadline ? new Date(tender.deadline).toDateString() : "Not specified"}

Description:
${tender.description}

Requirements:
${requirementsSummary}`,
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  const data = JSON.parse(raw);

  const [bidScore] = await db
    .insert(bidScoresTable)
    .values({
      tenderId,
      fitScore: data.fitScore ?? 0,
      fitLevel: data.fitLevel ?? "weak",
      reasoning: data.reasoning ?? "",
      flags: JSON.stringify(data.flags ?? []),
      completenessScore: typeof data.completenessScore === "number" ? Math.min(100, Math.max(0, Math.round(data.completenessScore))) : 0,
      missingFields: JSON.stringify(Array.isArray(data.missingFields) ? data.missingFields : []),
    })
    .returning();

  const newStatus = data.fitLevel === "no_bid" ? "no_bid" : "screened";
  await db
    .update(tendersTable)
    .set({ status: newStatus, recommendationScore: data.fitScore ?? 0, updatedAt: new Date() })
    .where(eq(tendersTable.id, tenderId));

  return bidScore;
}

async function runGenerateStrategy(tenderId: number) {
  const [tender] = await db.select().from(tendersTable).where(eq(tendersTable.id, tenderId));
  if (!tender) throw new Error("Tender not found");

  const requirements = await db
    .select()
    .from(tenderRequirementsTable)
    .where(eq(tenderRequirementsTable.tenderId, tenderId))
    .orderBy(tenderRequirementsTable.orderIndex);

  const [bidScore] = await db
    .select()
    .from(bidScoresTable)
    .where(eq(bidScoresTable.tenderId, tenderId))
    .orderBy(desc(bidScoresTable.createdAt))
    .limit(1);

  const requirementsSummary = requirements.length > 0
    ? requirements.map((r, i) => `${i + 1}. [${r.category}${r.isMandatory ? ", MANDATORY" : ""}] ${r.requirementText}`).join("\n")
    : "No requirements extracted.";

  const completion = await openai.chat.completions.create({
    model: AI_MODEL,
    max_completion_tokens: 2000,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are a senior bid strategist at ONWRD, a full-service marketing and strategy agency in the Bahamas. Generate a proposal strategy brief that will guide the proposal writers.

Return JSON with:
- positioning: string (1-2 sentences: how ONWRD should position itself for this specific opportunity — what unique angle to take)
- winThemes: string[] (exactly 3-4 specific themes that should run throughout the proposal, e.g. "Local Caribbean expertise", "Measurable community impact")
- recommendedCaseStudies: string[] (2-3 specific ONWRD case study names from the portfolio below that are most relevant to cite)
- risks: string[] (2-4 specific risks the proposal must proactively address)
- messagingGuidance: string (1-2 sentences on tone, emphasis, and what the evaluators likely care about most)

${ONWRD_CASE_STUDIES}`,
      },
      {
        role: "user",
        content: `Generate a proposal strategy for this tender:

Title: ${tender.title}
Agency: ${tender.agency}
Category: ${tender.category}
Value: ${tender.valueAmount ?? "Not specified"}
Deadline: ${tender.deadline ? new Date(tender.deadline).toDateString() : "Not specified"}

Description:
${tender.description}

Requirements:
${requirementsSummary}

${bidScore ? `Bid Score: ${bidScore.fitScore}/100 (${bidScore.fitLevel})\nScoring Reasoning: ${bidScore.reasoning}` : ""}`,
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  const data = JSON.parse(raw);

  await db.delete(proposalStrategiesTable).where(eq(proposalStrategiesTable.tenderId, tenderId));

  const [strategy] = await db
    .insert(proposalStrategiesTable)
    .values({
      tenderId,
      positioning: data.positioning ?? "",
      winThemes: JSON.stringify(data.winThemes ?? []),
      recommendedCaseStudies: JSON.stringify(data.recommendedCaseStudies ?? []),
      risks: JSON.stringify(data.risks ?? []),
      messagingGuidance: data.messagingGuidance ?? "",
    })
    .returning();

  return strategy;
}

async function autoAnalyzeOpportunity(tenderId: number) {
  const fail = async (step: string, err: unknown) => {
    console.error(`[auto-pipeline] ${step} failed for tender ${tenderId}:`, err);
    await db
      .update(tendersTable)
      .set({ status: "analysis_failed", updatedAt: new Date() })
      .where(eq(tendersTable.id, tenderId));
  };

  await db
    .update(tendersTable)
    .set({ status: "analysing", updatedAt: new Date() })
    .where(eq(tendersTable.id, tenderId));

  try {
    await runExtractRequirements(tenderId);
  } catch (err) {
    await fail("requirement extraction", err);
    return;
  }
  let bidScore;
  try {
    bidScore = await runBidScoring(tenderId);
  } catch (err) {
    await fail("bid scoring", err);
    return;
  }

  // Skip strategy generation for no_bid (includes individual employment roles)
  if (bidScore.fitLevel === "no_bid") return;

  try {
    await runGenerateStrategy(tenderId);
  } catch (err) {
    await fail("strategy generation", err);
  }
}

// ── List opportunities (with latest bid score per tender) ───────────────────
router.get("/opportunities", async (req, res) => {
  try {
    const tenders = await db
      .select()
      .from(tendersTable)
      .orderBy(desc(tendersTable.recommendationScore), desc(tendersTable.createdAt));

    const allScores = await db
      .select()
      .from(bidScoresTable)
      .orderBy(desc(bidScoresTable.createdAt));

    const scoreMap = new Map<number, typeof allScores[0]>();
    for (const s of allScores) {
      if (!scoreMap.has(s.tenderId)) scoreMap.set(s.tenderId, s);
    }

    res.json(tenders.map((t) => ({ ...t, bidScore: scoreMap.get(t.id) ?? null })));
  } catch (err) {
    req.log.error({ err }, "Error listing opportunities");
    res.status(500).json({ error: "Failed to list opportunities" });
  }
});

// ── Create opportunity ─────────────────────────────────────────────────────
router.post("/opportunities", async (req, res) => {
  const { title, agency, description, category, deadline, valueAmount, sourceUrl, contactInfo, rawText } = req.body as {
    title: string;
    agency: string;
    description: string;
    category?: string;
    deadline?: string;
    valueAmount?: string;
    sourceUrl?: string;
    contactInfo?: string;
    rawText?: string;
  };

  if (!title || !agency || !description) {
    res.status(400).json({ error: "title, agency, and description are required" });
    return;
  }

  try {
    const [created] = await db
      .insert(tendersTable)
      .values({
        title,
        agency,
        description,
        category: category ?? "General",
        deadline: deadline ? new Date(deadline) : null,
        valueAmount: valueAmount ?? null,
        sourceUrl: sourceUrl ?? null,
        contactInfo: contactInfo ?? null,
        rawText: rawText ?? null,
        status: "opportunity_found",
        recommendationScore: 0,
      })
      .returning();

    res.status(201).json(created);

    void autoAnalyzeOpportunity(created.id);
  } catch (err) {
    req.log.error({ err }, "Error creating opportunity");
    res.status(500).json({ error: "Failed to create opportunity" });
  }
});

// ── Get opportunity with requirements + bid score + strategy ───────────────
router.get("/opportunities/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  try {
    const [tender] = await db.select().from(tendersTable).where(eq(tendersTable.id, id));
    if (!tender) {
      res.status(404).json({ error: "Opportunity not found" });
      return;
    }

    const requirements = await db
      .select()
      .from(tenderRequirementsTable)
      .where(eq(tenderRequirementsTable.tenderId, id))
      .orderBy(tenderRequirementsTable.orderIndex);

    const [bidScore] = await db
      .select()
      .from(bidScoresTable)
      .where(eq(bidScoresTable.tenderId, id))
      .orderBy(desc(bidScoresTable.createdAt))
      .limit(1);

    const [strategy] = await db
      .select()
      .from(proposalStrategiesTable)
      .where(eq(proposalStrategiesTable.tenderId, id))
      .orderBy(desc(proposalStrategiesTable.createdAt))
      .limit(1);

    res.json({ ...tender, requirements, bidScore: bidScore ?? null, strategy: strategy ?? null });
  } catch (err) {
    req.log.error({ err }, "Error fetching opportunity");
    res.status(500).json({ error: "Failed to fetch opportunity" });
  }
});

// ── Update opportunity (status + all enrichable fields) ────────────────────
router.put("/opportunities/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const {
    status, title, agency, description,
    category, valueAmount, deadline, rawText, contactInfo, sourceUrl,
  } = req.body as {
    status?: string; title?: string; agency?: string; description?: string;
    category?: string; valueAmount?: string; deadline?: string;
    rawText?: string; contactInfo?: string; sourceUrl?: string;
  };

  try {
    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (status !== undefined) updateData.status = status;
    if (title !== undefined) updateData.title = title;
    if (agency !== undefined) updateData.agency = agency;
    if (description !== undefined) updateData.description = description;
    if (category !== undefined) updateData.category = category;
    if (valueAmount !== undefined) updateData.valueAmount = valueAmount || null;
    if (deadline !== undefined) updateData.deadline = deadline ? new Date(deadline) : null;
    if (rawText !== undefined) updateData.rawText = rawText || null;
    if (contactInfo !== undefined) updateData.contactInfo = contactInfo || null;
    if (sourceUrl !== undefined) updateData.sourceUrl = sourceUrl || null;

    const [updated] = await db
      .update(tendersTable)
      .set(updateData)
      .where(eq(tendersTable.id, id))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Opportunity not found" });
      return;
    }
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Error updating opportunity");
    res.status(500).json({ error: "Failed to update opportunity" });
  }
});

// ── Extract requirements (manual trigger) ─────────────────────────────────
router.post("/opportunities/:id/extract-requirements", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  try {
    const inserted = await runExtractRequirements(id);
    if (inserted.length === 0) {
      res.status(400).json({ error: "Could not extract requirements from this opportunity" });
      return;
    }
    res.json({ requirements: inserted, count: inserted.length });
  } catch (err) {
    req.log.error({ err }, "Error extracting requirements");
    res.status(500).json({ error: "Failed to extract requirements" });
  }
});

// ── Score bid/no-bid (manual trigger) ─────────────────────────────────────
router.post("/opportunities/:id/score", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  try {
    const bidScore = await runBidScoring(id);
    res.json(bidScore);
  } catch (err) {
    req.log.error({ err }, "Error scoring opportunity");
    res.status(500).json({ error: "Failed to score opportunity" });
  }
});

// ── Generate strategy brief (manual trigger) ──────────────────────────────
router.post("/opportunities/:id/generate-strategy", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  try {
    const strategy = await runGenerateStrategy(id);
    res.json(strategy);
  } catch (err) {
    req.log.error({ err }, "Error generating strategy");
    res.status(500).json({ error: "Failed to generate strategy" });
  }
});

// ── Generate section-based proposal ───────────────────────────────────────
router.post("/opportunities/:id/generate-proposal", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const [tender] = await db.select().from(tendersTable).where(eq(tendersTable.id, id));
  if (!tender) {
    res.status(404).json({ error: "Opportunity not found" });
    return;
  }

  const requirements = await db
    .select()
    .from(tenderRequirementsTable)
    .where(eq(tenderRequirementsTable.tenderId, id))
    .orderBy(tenderRequirementsTable.orderIndex);

  const [strategy] = await db
    .select()
    .from(proposalStrategiesTable)
    .where(eq(proposalStrategiesTable.tenderId, id))
    .orderBy(desc(proposalStrategiesTable.createdAt))
    .limit(1);

  const briefText = `TENDER OPPORTUNITY — ${tender.title}

Issuing Agency: ${tender.agency}
Category: ${tender.category}
${tender.deadline ? `Submission Deadline: ${new Date(tender.deadline).toDateString()}` : ""}
${tender.valueAmount ? `Estimated Value: ${tender.valueAmount}` : ""}
${tender.contactInfo ? `Contact: ${tender.contactInfo}` : ""}
${tender.sourceUrl ? `Source: ${tender.sourceUrl}` : ""}

SCOPE / DESCRIPTION:
${tender.description}

${requirements.length > 0 ? `\nEXTRACTED REQUIREMENTS:\n${requirements.map((r, i) => `${i + 1}. [${r.category}${r.isMandatory ? ", MANDATORY" : ""}] ${r.requirementText}`).join("\n")}` : ""}`;

  const strategyContext = strategy
    ? `\nPROPOSAL STRATEGY BRIEF:\nPositioning: ${strategy.positioning}\nWin Themes: ${JSON.parse(strategy.winThemes ?? "[]").join(", ")}\nRecommended Case Studies: ${JSON.parse(strategy.recommendedCaseStudies ?? "[]").join(", ")}\nMessaging Guidance: ${strategy.messagingGuidance}\nRisks to Address: ${JSON.parse(strategy.risks ?? "[]").join(", ")}`
    : "";

  const [draft] = await db
    .insert(proposalsTable)
    .values({
      clientName: tender.agency,
      industry: tender.category,
      briefText,
      proposalContent: "Generating proposal sections — please refresh in ~30 seconds.",
      status: "proposal_drafting",
      tenderId: id,
    })
    .returning();

  await db
    .update(tendersTable)
    .set({ proposalId: draft.id, status: "proposal_drafting", updatedAt: new Date() })
    .where(eq(tendersTable.id, id));

  const sectionRows = await db
    .insert(proposalSectionsTable)
    .values(
      SECTION_DEFINITIONS.map((s) => ({
        proposalId: draft.id,
        sectionKey: s.key,
        title: s.title,
        content: "",
        status: "not_started",
        orderIndex: s.order,
      }))
    )
    .returning();

  res.status(201).json({ proposal: draft, sections: sectionRows });

  (async () => {
    try {
      const completion = await openai.chat.completions.create({
        model: AI_MODEL,
        max_tokens: 16000,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `You are a senior proposal writer at ONWRD, a full-service marketing and strategy agency in the Bahamas. Write a complete, professional proposal responding to a public tender opportunity.

RULES:
- Write in plain, direct English. No jargon, no waffle, no filler.
- Do NOT invent ONWRD credentials, metrics, clients, or outcomes not supported by the case studies below.
- If a section requires specific ONWRD information you don't have (specific pricing, team member names, certifications), insert [NEEDS ONWRD INPUT: brief description of what is needed].
- Never fabricate specific numbers, dates, or facts about the tender that aren't in the brief.
- The Case Studies section MUST cite real ONWRD work from the list below.
- Follow the proposal strategy brief closely — use the positioning, win themes, and recommended case studies provided.

${ONWRD_CASE_STUDIES}

Return JSON with a "sections" array. Each element:
- key: the section key
- content: the full written section content (use markdown — headings with ##, bold with **, bullets with -)`,
          },
          {
            role: "user",
            content: `Write all 15 sections of a proposal for this tender:

${briefText}
${strategyContext}

Sections to write (return all 15):
${SECTION_DEFINITIONS.map((s) => `- ${s.key}: ${s.title}`).join("\n")}`,
          },
        ],
      });

      const raw = completion.choices[0]?.message?.content ?? "{}";
      const data = JSON.parse(raw);
      const sections: { key: string; content: string }[] = data.sections ?? [];

      const [genRun] = await db
        .insert(proposalGenerationRunsTable)
        .values({
          proposalId: draft.id,
          model: AI_MODEL,
          promptVersion: "2.0",
          retrievedKnowledgeIds: "[]",
          status: "completed",
        })
        .returning();

      let combinedContent = "";
      for (const sectionDef of SECTION_DEFINITIONS) {
        const generated = sections.find((s) => s.key === sectionDef.key);
        const content = generated?.content ?? `[NEEDS ONWRD INPUT: ${sectionDef.title} section not generated]`;
        const hasBlocker = content.includes("[NEEDS ONWRD INPUT");
        const status = hasBlocker ? "blocked_missing_input" : "drafted";

        await db
          .update(proposalSectionsTable)
          .set({ content, status, generationRunId: genRun.id, updatedAt: new Date() })
          .where(
            and(
              eq(proposalSectionsTable.proposalId, draft.id),
              eq(proposalSectionsTable.sectionKey, sectionDef.key)
            )
          );

        combinedContent += `## ${sectionDef.title}\n\n${content}\n\n`;
      }

      const hasBlockedSections = sections.some((s) => s.content?.includes("[NEEDS ONWRD INPUT"));
      await db
        .update(proposalsTable)
        .set({
          proposalContent: combinedContent.trim(),
          status: hasBlockedSections ? "needs_onwrd_input" : "ready_for_review",
          updatedAt: new Date(),
        })
        .where(eq(proposalsTable.id, draft.id));

      await db
        .update(tendersTable)
        .set({
          status: hasBlockedSections ? "needs_onwrd_input" : "ready_for_review",
          updatedAt: new Date(),
        })
        .where(eq(tendersTable.id, id));
    } catch (err) {
      console.error("[opportunity→proposal] generation failed:", err);
      await db
        .update(proposalsTable)
        .set({
          proposalContent: `Generation failed. Please regenerate.\n\nOriginal brief:\n${briefText}`,
          status: "draft",
          updatedAt: new Date(),
        })
        .where(eq(proposalsTable.id, draft.id));
    }
  })();
});

// ── Manual tender import ───────────────────────────────────────────────────
const manualUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
}).single("file");

router.post("/tenders/manual", (req, res, next) => {
  manualUpload(req, res, (err: unknown) => {
    if (err) {
      const e = err as { code?: string; message?: string };
      if (e.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: "File too large. Max 50 MB." });
        return;
      }
      res.status(400).json({ error: e.message ?? "Upload failed" });
      return;
    }
    next();
  });
}, async (req, res) => {
  const bodyUrl = (req.body as Record<string, string>)?.url?.trim() || null;
  const file = req.file ?? null;

  if (!file && !bodyUrl) {
    res.status(400).json({ error: "Provide a file (.pdf, .docx, .txt) or a URL." });
    return;
  }

  try {
    let rawText = "";
    let sourceUrl: string | null = null;

    if (file) {
      const { mimetype, originalname, buffer } = file;
      const name = originalname.toLowerCase();
      if (
        mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        name.endsWith(".docx")
      ) {
        const result = await mammoth.extractRawText({ buffer });
        rawText = result.value;
      } else if (mimetype === "application/pdf" || name.endsWith(".pdf")) {
        const result = await pdfParse(buffer);
        rawText = (result.text ?? "").trim();
        if (!rawText) {
          res.status(400).json({
            error: "No selectable text found in this PDF. It may be a scanned image — try copy/pasting the text instead.",
          });
          return;
        }
      } else if (mimetype === "text/plain" || name.endsWith(".txt")) {
        rawText = buffer.toString("utf-8");
      } else {
        res.status(400).json({ error: "Unsupported file type. Upload a .pdf, .docx, or .txt file." });
        return;
      }
    } else if (bodyUrl) {
      // SSRF protection: validate protocol and block private/internal IP ranges
      let parsed: URL;
      try {
        parsed = new URL(bodyUrl);
      } catch {
        res.status(400).json({ error: "Invalid URL — must be a valid http:// or https:// address." });
        return;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        res.status(400).json({ error: "Only http and https URLs are supported." });
        return;
      }
      const hostname = parsed.hostname.toLowerCase();
      const blocked =
        hostname === "localhost" ||
        hostname === "0.0.0.0" ||
        /^127\./.test(hostname) ||
        /^10\./.test(hostname) ||
        /^192\.168\./.test(hostname) ||
        /^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname) ||
        /^169\.254\./.test(hostname) ||
        hostname === "::1" ||
        hostname.endsWith(".local") ||
        hostname.endsWith(".internal");
      if (blocked) {
        res.status(400).json({ error: "That URL resolves to a private or internal address and cannot be fetched." });
        return;
      }
      sourceUrl = bodyUrl;
      let html = "";
      try {
        const resp = await fetch(bodyUrl, {
          signal: AbortSignal.timeout(15_000),
          headers: { "User-Agent": "Mozilla/5.0 (compatible; ONWRDBot/1.0)" },
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        html = await resp.text();
      } catch (err) {
        res.status(400).json({ error: `Could not fetch URL: ${(err as Error).message}` });
        return;
      }
      rawText = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/\s{2,}/g, "\n")
        .trim();
    }

    if (!rawText || rawText.length < 50) {
      res.status(400).json({ error: "Not enough text could be extracted. Try a different file or URL." });
      return;
    }

    const firstLine = rawText.split("\n").find((l) => l.trim().length > 5)?.trim() ?? "";
    let title = firstLine.slice(0, 120);
    if (!title && sourceUrl) {
      try { title = new URL(sourceUrl).hostname; } catch { title = "Manual Import"; }
    }
    if (!title) title = "Manual Import";

    const [created] = await db
      .insert(tendersTable)
      .values({
        title,
        agency: "Manual Import",
        description: rawText.slice(0, 500),
        category: "General",
        rawText,
        sourceUrl,
        status: "opportunity_found",
        recommendationScore: 0,
      })
      .returning();

    res.status(201).json({ id: created.id, title: created.title, status: created.status });

    void autoAnalyzeOpportunity(created.id);
  } catch (err) {
    req.log.error({ err }, "Error processing manual tender import");
    res.status(500).json({ error: "Failed to process import. Please try again." });
  }
});

// ── Generate Bid Proposal ─────────────────────────────────────────────────────
router.post("/proposals/generate-bid", async (req, res) => {
  const { opportunityId } = req.body as { opportunityId: number };

  if (!opportunityId || typeof opportunityId !== "number") {
    res.status(400).json({ error: "opportunityId is required and must be a number" });
    return;
  }

  try {
    // 1. Fetch tender
    const [tender] = await db.select().from(tendersTable).where(eq(tendersTable.id, opportunityId));
    if (!tender) {
      res.status(404).json({ error: "Opportunity not found" });
      return;
    }

    // 2. Fetch latest bid score
    const [bidScore] = await db
      .select()
      .from(bidScoresTable)
      .where(eq(bidScoresTable.tenderId, opportunityId))
      .orderBy(desc(bidScoresTable.createdAt))
      .limit(1);

    // 3. Fetch extracted requirements
    const requirements = await db
      .select()
      .from(tenderRequirementsTable)
      .where(eq(tenderRequirementsTable.tenderId, opportunityId));

    // 4. Fetch strategy
    const [strategy] = await db
      .select()
      .from(proposalStrategiesTable)
      .where(eq(proposalStrategiesTable.tenderId, opportunityId))
      .orderBy(desc(proposalStrategiesTable.createdAt))
      .limit(1);

    // 5. Compile the master brief
    const parts: string[] = [];
    parts.push(`TENDER TITLE: ${tender.title}`);
    parts.push(`ISSUING AUTHORITY: ${tender.agency}`);
    parts.push(`CATEGORY: ${tender.category}`);
    if (tender.valueAmount) parts.push(`ESTIMATED CONTRACT VALUE: ${tender.valueAmount}`);
    if (tender.deadline) {
      const d = new Date(tender.deadline);
      parts.push(`SUBMISSION DEADLINE: ${d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`);
    }
    if (tender.contactInfo) parts.push(`CONTACT: ${tender.contactInfo}`);
    if (tender.sourceUrl) parts.push(`SOURCE URL: ${tender.sourceUrl}`);
    parts.push(`\nDESCRIPTION:\n${tender.description}`);
    if (tender.rawText && tender.rawText.length > 50) {
      parts.push(`\nFULL RFP / TENDER DOCUMENT:\n${tender.rawText.slice(0, 10000)}`);
    }
    if (requirements.length > 0) {
      parts.push(
        `\nEXTRACTED REQUIREMENTS:\n${requirements
          .map((r, i) => `${i + 1}. [${r.category ?? "General"}] ${r.description}`)
          .join("\n")}`,
      );
    }
    if (bidScore) {
      parts.push(
        `\nBID INTELLIGENCE:\nFit Score: ${bidScore.fitScore}/100 (${bidScore.fitLevel})\nBrief Completeness: ${bidScore.completenessScore}/100\nAnalysis: ${bidScore.reasoning}`,
      );
    }
    if (strategy) {
      const themes = (() => {
        try { return (JSON.parse(strategy.winThemes) as string[]).join(", "); } catch { return strategy.winThemes; }
      })();
      parts.push(
        `\nWIN STRATEGY:\nPositioning: ${strategy.positioning}\nWin Themes: ${themes}`,
      );
    }

    const briefContext = parts.join("\n");

    const systemPrompt = `You are the Senior Proposal Writer at ONWRD Advisors — a Caribbean-based strategy and communications consultancy with a track record of winning public-sector and development-finance tenders. Your proposals are known for being incisive, client-centred, and strategically grounded.

Your task is to write a complete, ready-to-submit proposal document for the tender described below. The output must be polished, persuasive, and use ONWRD's authoritative voice — confident without being arrogant, expert without being impenetrable.

DOCUMENT STRUCTURE (follow this exactly, using # Markdown headings):

# ONWRD PROJECT PROPOSAL

## EXECUTIVE SUMMARY
Two to three paragraphs. Open with a direct statement of ONWRD's understanding of the client's core challenge. Then articulate why ONWRD is uniquely placed to solve it. Close with a one-sentence commitment statement.

## UNDERSTANDING THE REQUIREMENT
Demonstrate deep reading of the RFP. Restate the problem in sharper terms than the client used. Name the key outcomes the issuing authority is trying to achieve.

## OUR PROPOSED APPROACH
### Phase 1 — Discovery & Stakeholder Alignment
### Phase 2 — Strategy & Framework Development
### Phase 3 — Implementation & Delivery
### Phase 4 — Review & Knowledge Transfer
For each phase: key activities, deliverables, who leads.

## RELEVANT CREDENTIALS & CASE STUDIES
Draw ONLY from the real ONWRD case studies provided. Do not invent credentials. Select the 2–3 most relevant to this specific tender. For each: project name, the challenge, ONWRD's contribution, the result.

## TEAM & EXPERTISE
Position ONWRD's principals as sector experts. Speak to relevant expertise without inventing individuals. Keep it concise.

## PROPOSED TIMELINE
A milestone table in Markdown format with columns: Phase | Key Activity | Deliverable | Week.

## INVESTMENT SUMMARY
If a contract value is provided, suggest a breakdown. If not, write: "ONWRD will provide a detailed investment proposal upon request, structured to align with the budget parameters of this procurement."

## WHY ONWRD
A closing section that crystallises the core argument for choosing ONWRD: regional expertise, strategic depth, and a proven track record of delivering results in the Caribbean development sector.

---

STYLE RULES:
- Write in first-person plural ("We propose", "Our approach", "ONWRD will…")
- No filler phrases like "In conclusion," or "It is important to note that"
- Use bold (**text**) for key deliverables and named outputs
- Use bullet lists for activities and requirements only — not for prose
- Tables for timelines only
- Maximum 2,500 words in the body (not counting headings)
- Never hallucinate credentials, case studies, or team members not mentioned in the brief or the real case study list`;

    // 6. Call OpenAI (master proposal generation)
    req.log.info({ tenderId: opportunityId }, "[generate-bid] Calling OpenAI proposal writer…");

    const completion = await openai.chat.completions.create({
      model: AI_MODEL,
      max_tokens: 8192,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `TENDER BRIEF:\n${briefContext}\n\n---\nONWRD REAL CASE STUDIES (use only these):\n${ONWRD_CASE_STUDIES}\n\n---\nNow write the complete proposal document:`,
        },
      ],
    });

    const proposalContent = completion.choices[0]?.message?.content ?? "";
    if (!proposalContent) throw new Error("OpenAI returned empty proposal content");

    req.log.info({ tenderId: opportunityId, chars: proposalContent.length }, "[generate-bid] Proposal generated, exporting to Google Docs…");

    // 7. Export to Google Docs
    const { createGoogleDoc, appendContentWithLogo, shareWithAnyone } = await import("../lib/google-docs.js");
    const docTitle = `ONWRD Bid — ${tender.title.slice(0, 60)} — ${tender.agency}`.slice(0, 100);
    const doc = await createGoogleDoc(docTitle);
    const docId = doc.documentId;
    const docUrl = `https://docs.google.com/document/d/${docId}/edit`;

    await appendContentWithLogo(docId, proposalContent);
    await shareWithAnyone(docId);

    req.log.info({ tenderId: opportunityId, docId, docUrl }, "[generate-bid] Google Doc created");

    // 8. Update tender status
    await db
      .update(tendersTable)
      .set({ status: "bid_started", googleDocId: docId, googleDocUrl: docUrl, updatedAt: new Date() })
      .where(eq(tendersTable.id, opportunityId));

    res.json({ docId, docUrl, title: docTitle });
  } catch (err) {
    req.log.error({ err }, "[generate-bid] Error generating bid proposal");
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: `Failed to generate bid proposal: ${message}` });
  }
});

export default router;

