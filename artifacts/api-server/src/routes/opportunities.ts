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
import { eq, desc, and, inArray } from "drizzle-orm";
import { openai, AI_MODEL } from "@workspace/integrations-openai-ai-server";
import { ONWRD_CASE_STUDIES } from "../lib/onwrd-case-studies.js";
import { scoreTender } from "../lib/scoring-rules.js";
import {
  truncateToTokenBudget,
  classifyError,
  callWithSingleRetry,
  ANALYSIS_ACTIVE_STATUSES,
  EXTRACTION_MAX_TOKENS,
  MAX_REQUIREMENTS,
  MAX_REQ_CHARS,
  ANALYSIS_TIMEOUT_MS,
  getFirstIncompleteStep,
  type AnalysisActiveStatus,
  type AnalysisStep,
} from "../lib/analysis-utils.js";

const router = Router();

// ── Active-run registry ───────────────────────────────────────────────────────
// One entry per tender that is currently being analysed.
// Cleared when the run finishes (success, failure, or cancellation).
interface ActiveRun {
  runId:      string;
  controller: AbortController;
  step:       string; // current step name, updated as the pipeline progresses
}
const activeRuns = new Map<number, ActiveRun>();

const SECTION_DEFINITIONS = [
  { key: "executive_summary",   title: "Executive Summary",                         order: 0 },
  { key: "client_context",      title: "Client Context and Problem Definition",      order: 1 },
  { key: "goals_kpis",          title: "Goals, KPIs and Success Criteria",           order: 2 },
  { key: "strategic_approach",  title: "Recommended Strategic Approach",             order: 3 },
  { key: "scope_of_work",       title: "Detailed Scope of Work",                     order: 4 },
  { key: "deliverables",        title: "Deliverables Register",                      order: 5 },
  { key: "timeline",            title: "Timeline, Milestones and Dependencies",      order: 6 },
  { key: "team_structure",      title: "Team Structure and Ways of Working",         order: 7 },
  { key: "investment",          title: "Investment and Commercial Terms",            order: 8 },
  { key: "assumptions_risks",   title: "Assumptions, Exclusions and Risks",          order: 9 },
  { key: "governance",          title: "Governance, Approval and Change Control",    order: 10 },
  { key: "why_onwrd",           title: "Why ONWRD",                                 order: 11 },
  { key: "case_studies",        title: "Case Studies and Credentials",               order: 12 },
  { key: "legal_terms",         title: "Legal and Operational Terms",                order: 13 },
  { key: "next_steps",          title: "Next Steps and Acceptance",                  order: 14 },
];

// ── Helper: check whether a tender is already being analysed ─────────────────
function isActiveStatus(status: string): status is AnalysisActiveStatus {
  return (ANALYSIS_ACTIVE_STATUSES as readonly string[]).includes(status);
}

// ── Deterministic scoring — no AI call ───────────────────────────────────────
// Applied immediately on tender create/update and as the pipeline bid_scoring step.
async function applyDeterministicScore(tenderId: number) {
  const [tender] = await db.select().from(tendersTable).where(eq(tendersTable.id, tenderId));
  if (!tender) throw new Error("Tender not found");

  const result = scoreTender({
    title:       tender.title,
    agency:      tender.agency,
    category:    tender.category,
    description: tender.description,
    deadline:    tender.deadline ?? null,
    valueAmount: tender.valueAmount ?? null,
    rawText:     tender.rawText ?? null,
    contactInfo: tender.contactInfo ?? null,
  });

  const [bidScore] = await db
    .insert(bidScoresTable)
    .values({
      tenderId,
      fitScore:          result.fitScore,
      fitLevel:          result.fitLevel,
      reasoning:         result.reasoning,
      flags:             JSON.stringify(result.flags),
      completenessScore: result.completenessScore,
      missingFields:     JSON.stringify(result.missingFields),
    })
    .returning();

  await db.update(tendersTable).set({
    recommendationScore: result.fitScore,
    updatedAt:           new Date(),
  }).where(eq(tendersTable.id, tenderId));

  return bidScore;
}

// ── Step 1: Extract requirements ─────────────────────────────────────────────
async function runExtractRequirements(tenderId: number, cancelSignal?: AbortSignal) {
  const [tender] = await db
    .select()
    .from(tendersTable)
    .where(eq(tendersTable.id, tenderId));
  if (!tender) throw new Error("Tender not found");

  // Snapshot existing requirements so they can be restored if extraction fails
  const existing = await db
    .select()
    .from(tenderRequirementsTable)
    .where(eq(tenderRequirementsTable.tenderId, tenderId));

  // Truncate source text to ≈ 12 000 tokens, preserving head + tail
  const rawSource = tender.rawText || tender.description;
  const sourceText = truncateToTokenBudget(rawSource);

  // Compose user-cancel signal + 90 s hard timeout
  const timeoutSignal = AbortSignal.timeout(ANALYSIS_TIMEOUT_MS);
  const signal = cancelSignal
    ? AbortSignal.any([cancelSignal, timeoutSignal])
    : timeoutSignal;

  let completion: Awaited<ReturnType<typeof openai.chat.completions.create>>;
  try {
    completion = await callWithSingleRetry(() =>
      openai.chat.completions.create(
        {
          model: AI_MODEL,
          max_completion_tokens: EXTRACTION_MAX_TOKENS,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                `You extract structured requirements from tender/RFP documents.\n\n` +
                `Return ONLY a JSON object: { "requirements": [...] }\n` +
                `Each item: { "requirementText": string, "category": string, "isMandatory": boolean }\n\n` +
                `Rules:\n` +
                `- Return at most ${MAX_REQUIREMENTS} distinct, actionable requirements.\n` +
                `- Each requirementText MUST be ≤ ${MAX_REQ_CHARS} characters. Summarise if longer.\n` +
                `- category: one of technical | budget | timeline | personnel | certifications | format | deliverable | compliance | general\n` +
                `- isMandatory: true for must/shall/required; false for preferred/desired/optional.\n` +
                `- Include: submission format, eligibility criteria, deliverable specs, timeline constraints, compliance items.\n` +
                `- Skip vague or duplicate statements.\n` +
                `- No commentary or extra keys — only the JSON object.`,
            },
            {
              role: "user",
              content: `Extract requirements from this tender.\n\nTitle: ${tender.title}\nAgency: ${tender.agency}\n\n${sourceText}`,
            },
          ],
        },
        { signal },
      ),
    );
  } catch (err) {
    if (cancelSignal?.aborted) {
      const e = new Error("Analysis cancelled by user"); e.name = "CancelledError"; throw e;
    }
    if (timeoutSignal.aborted || (err instanceof Error && err.name === "AbortError")) {
      throw new Error("AI request timed out after 90s");
    }
    throw err;
  }

  // Record token usage (accumulate across steps within one analysis)
  const usage = completion.usage;
  await db
    .update(tendersTable)
    .set({
      aiModelUsed: completion.model,
      aiInputTokens:  (tender.aiInputTokens  ?? 0) + (usage?.prompt_tokens     ?? 0),
      aiOutputTokens: (tender.aiOutputTokens ?? 0) + (usage?.completion_tokens ?? 0),
      updatedAt: new Date(),
    })
    .where(eq(tendersTable.id, tenderId));

  // Parse and validate response
  const raw = completion.choices[0]?.message?.content ?? "{}";
  type RawReq = { requirementText?: unknown; category?: unknown; isMandatory?: unknown };
  let data: { requirements?: RawReq[] };
  try {
    data = JSON.parse(raw) as typeof data;
  } catch {
    console.warn(`[extract] JSON parse failed for tender ${tenderId} — preserving ${existing.length} existing requirements`);
    return existing;
  }

  const reqs = (data.requirements ?? [])
    .slice(0, MAX_REQUIREMENTS)
    .map((r) => ({
      requirementText: String(r.requirementText ?? "").slice(0, MAX_REQ_CHARS).trim(),
      category:        String(r.category        ?? "general"),
      isMandatory:     Boolean(r.isMandatory    ?? true),
    }))
    .filter((r) => r.requirementText.length > 0);

  if (reqs.length === 0) {
    console.warn(`[extract] Zero requirements returned for tender ${tenderId} — preserving ${existing.length} existing`);
    return existing;
  }

  // Replace requirements atomically
  await db.delete(tenderRequirementsTable).where(eq(tenderRequirementsTable.tenderId, tenderId));

  const inserted = await db
    .insert(tenderRequirementsTable)
    .values(
      reqs.map((r, i) => ({
        tenderId,
        requirementText: r.requirementText,
        category:        r.category,
        isMandatory:     r.isMandatory,
        isAnswered:      false,
        orderIndex:      i,
      })),
    )
    .returning();

  await db
    .update(tendersTable)
    .set({ requirementsExtractedAt: new Date(), updatedAt: new Date() })
    .where(eq(tendersTable.id, tenderId));

  return inserted;
}

// ── Step 2: Bid scoring (deterministic — no AI call) ─────────────────────────
// Instant rules-based evaluation; cancelSignal is accepted for pipeline
// compatibility but not used (scoring is synchronous, < 5 ms).
async function runBidScoring(tenderId: number, _cancelSignal?: AbortSignal) {
  return applyDeterministicScore(tenderId);
}

// ── Step 3: Generate strategy brief ─────────────────────────────────────────
async function runGenerateStrategy(tenderId: number, cancelSignal?: AbortSignal) {
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

  const requirementsSummary =
    requirements.length > 0
      ? requirements
          .map((r, i) => `${i + 1}. [${r.category}${r.isMandatory ? ", MANDATORY" : ""}] ${r.requirementText}`)
          .join("\n")
      : "No requirements extracted.";

  const timeoutSignal = AbortSignal.timeout(ANALYSIS_TIMEOUT_MS);
  const signal = cancelSignal
    ? AbortSignal.any([cancelSignal, timeoutSignal])
    : timeoutSignal;

  let completion: Awaited<ReturnType<typeof openai.chat.completions.create>>;
  try {
    completion = await openai.chat.completions.create({
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
    }, { signal });
  } catch (err) {
    if (cancelSignal?.aborted) {
      const e = new Error("Analysis cancelled by user"); e.name = "CancelledError"; throw e;
    }
    if (timeoutSignal.aborted || (err instanceof Error && err.name === "AbortError")) {
      throw new Error("AI request timed out after 90s");
    }
    throw err;
  }

  const raw = completion.choices[0]?.message?.content ?? "{}";
  const data = JSON.parse(raw) as {
    positioning?: string;
    winThemes?: string[];
    recommendedCaseStudies?: string[];
    risks?: string[];
    messagingGuidance?: string;
  };

  await db.delete(proposalStrategiesTable).where(eq(proposalStrategiesTable.tenderId, tenderId));

  const [strategy] = await db
    .insert(proposalStrategiesTable)
    .values({
      tenderId,
      positioning:            data.positioning            ?? "",
      winThemes:              JSON.stringify(data.winThemes              ?? []),
      recommendedCaseStudies: JSON.stringify(data.recommendedCaseStudies ?? []),
      risks:                  JSON.stringify(data.risks                  ?? []),
      messagingGuidance:      data.messagingGuidance      ?? "",
    })
    .returning();

  return strategy;
}

// ── Full analysis pipeline ───────────────────────────────────────────────────
async function autoAnalyzeOpportunity(
  tenderId: number,
  resumeFrom: AnalysisStep = "requirements_extracting",
  runId: string = crypto.randomUUID(),
): Promise<void> {
  const controller = new AbortController();
  const { signal } = controller;

  // Guard: skip if already running (unless the caller is the resume endpoint, which pre-checked)
  const [current] = await db
    .select({ status: tendersTable.status, completedSteps: tendersTable.completedSteps })
    .from(tendersTable)
    .where(eq(tendersTable.id, tenderId));
  if (!current) return;
  if (isActiveStatus(current.status)) {
    console.warn(`[pipeline] Tender ${tenderId} already in status "${current.status}" — skipping`);
    return;
  }

  // Inherit completed steps from DB when resuming mid-pipeline
  let completedSteps: string[] = [];
  if (resumeFrom !== "requirements_extracting") {
    try { completedSteps = JSON.parse(current.completedSteps ?? "[]") as string[]; } catch { /* noop */ }
  }

  activeRuns.set(tenderId, { runId, controller, step: resumeFrom });

  // ── Helpers ────────────────────────────────────────────────────────────────

  const fail = async (step: string, err: unknown): Promise<void> => {
    activeRuns.delete(tenderId);
    const { code } = classifyError(err);
    console.error(
      `[pipeline] tender=${tenderId} step="${step}" code=${code}:`,
      (err instanceof Error ? err.message : String(err)).slice(0, 200),
    );
    await db.update(tendersTable).set({
      status:              "analysis_failed",
      failedStep:          step,
      failedErrorCode:     code,
      analysisCompletedAt: new Date(),
      completedSteps:      JSON.stringify(completedSteps),
      updatedAt:           new Date(),
    }).where(and(eq(tendersTable.id, tenderId), eq(tendersTable.analysisRunId, runId)));
  };

  // Race-safe: only advance status if it still matches the expected value
  // (if cancel wrote analysis_cancelled in between, WHERE won't match → we exit)
  const advance = async (from: string, to: string): Promise<boolean> => {
    const [row] = await db.update(tendersTable).set({
      status:         to,
      completedSteps: JSON.stringify(completedSteps),
      updatedAt:      new Date(),
    }).where(and(
      eq(tendersTable.id, tenderId),
      eq(tendersTable.analysisRunId, runId),
      eq(tendersTable.status, from),
    )).returning({ id: tendersTable.id });
    return !!row;
  };

  // ① Write initial state to DB
  await db.update(tendersTable).set({
    status:              resumeFrom,
    analysisRunId:       runId,
    ...(resumeFrom === "requirements_extracting"
      ? { analysisStartedAt: new Date(), aiInputTokens: 0, aiOutputTokens: 0 }
      : {}),
    analysisCompletedAt: null,
    cancelledAt:         null,
    failedStep:          null,
    failedErrorCode:     null,
    aiModelUsed:         null,
    updatedAt:           new Date(),
  }).where(eq(tendersTable.id, tenderId));

  // ② Requirements extracting
  if (resumeFrom === "requirements_extracting") {
    activeRuns.get(tenderId)!.step = "requirements_extracting";
    if (signal.aborted) { activeRuns.delete(tenderId); return; }

    try {
      await runExtractRequirements(tenderId, signal);
    } catch (err) {
      if (signal.aborted) { activeRuns.delete(tenderId); return; }
      await fail("requirements_extracting", err);
      return;
    }

    completedSteps = [...new Set([...completedSteps, "requirements_extracting"])];
    const ok = await advance("requirements_extracting", "bid_scoring");
    if (!ok) { activeRuns.delete(tenderId); return; } // cancelled during write
    if (signal.aborted) { activeRuns.delete(tenderId); return; }
  }

  // ③ Bid scoring (skipped when resuming from strategy)
  if (resumeFrom !== "strategy_generating") {
    activeRuns.get(tenderId)!.step = "bid_scoring";
    if (signal.aborted) { activeRuns.delete(tenderId); return; }

    let bidScore: Awaited<ReturnType<typeof runBidScoring>>;
    try {
      bidScore = await runBidScoring(tenderId, signal);
    } catch (err) {
      if (signal.aborted) { activeRuns.delete(tenderId); return; }
      await fail("bid_scoring", err);
      return;
    }

    completedSteps = [...new Set([...completedSteps, "bid_scoring"])];

    if (bidScore.fitLevel === "no_bid") {
      activeRuns.delete(tenderId);
      await db.update(tendersTable).set({
        status:              "no_bid",
        analysisCompletedAt: new Date(),
        completedSteps:      JSON.stringify(completedSteps),
        updatedAt:           new Date(),
      }).where(and(eq(tendersTable.id, tenderId), eq(tendersTable.analysisRunId, runId)));
      return;
    }

    const ok = await advance("bid_scoring", "strategy_generating");
    if (!ok) { activeRuns.delete(tenderId); return; }
    if (signal.aborted) { activeRuns.delete(tenderId); return; }
  }

  // ④ Strategy generation
  activeRuns.get(tenderId)!.step = "strategy_generating";
  if (signal.aborted) { activeRuns.delete(tenderId); return; }

  try {
    await runGenerateStrategy(tenderId, signal);
  } catch (err) {
    if (signal.aborted) { activeRuns.delete(tenderId); return; }
    await fail("strategy_generating", err);
    return;
  }

  completedSteps = [...new Set([...completedSteps, "strategy_generating"])];
  activeRuns.delete(tenderId);

  await db.update(tendersTable).set({
    status:              "screened",
    analysisCompletedAt: new Date(),
    completedSteps:      JSON.stringify(completedSteps),
    updatedAt:           new Date(),
  }).where(and(eq(tendersTable.id, tenderId), eq(tendersTable.analysisRunId, runId)));
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

    const scoreMap = new Map<number, (typeof allScores)[0]>();
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
  const {
    title, agency, description, category,
    deadline, valueAmount, sourceUrl, contactInfo, rawText,
  } = req.body as {
    title: string; agency: string; description: string; category?: string;
    deadline?: string; valueAmount?: string; sourceUrl?: string;
    contactInfo?: string; rawText?: string;
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
        category:    category    ?? "General",
        deadline:    deadline    ? new Date(deadline) : null,
        valueAmount: valueAmount ?? null,
        sourceUrl:   sourceUrl   ?? null,
        contactInfo: contactInfo ?? null,
        rawText:     rawText     ?? null,
        status:      "opportunity_found",
        recommendationScore: 0,
      })
      .returning();

    // Auto-score immediately — deterministic rules, no AI call
    try {
      await applyDeterministicScore(created.id);
    } catch (scoreErr) {
      req.log.warn({ err: scoreErr }, "Auto-score after create failed — retry via /score");
    }
    res.status(201).json(created);
  } catch (err) {
    req.log.error({ err }, "Error creating opportunity");
    res.status(500).json({ error: "Failed to create opportunity" });
  }
});

// ── Get opportunity with requirements + bid score + strategy ───────────────
router.get("/opportunities/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  try {
    const [tender] = await db.select().from(tendersTable).where(eq(tendersTable.id, id));
    if (!tender) { res.status(404).json({ error: "Opportunity not found" }); return; }

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

// ── Update opportunity ─────────────────────────────────────────────────────
router.put("/opportunities/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

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
    if (status      !== undefined) updateData.status      = status;
    if (title       !== undefined) updateData.title       = title;
    if (agency      !== undefined) updateData.agency      = agency;
    if (description !== undefined) updateData.description = description;
    if (category    !== undefined) updateData.category    = category;
    if (valueAmount !== undefined) updateData.valueAmount = valueAmount || null;
    if (deadline    !== undefined) updateData.deadline    = deadline ? new Date(deadline) : null;
    if (rawText     !== undefined) updateData.rawText     = rawText || null;
    if (contactInfo !== undefined) updateData.contactInfo = contactInfo || null;
    if (sourceUrl   !== undefined) updateData.sourceUrl   = sourceUrl || null;

    const [updated] = await db
      .update(tendersTable)
      .set(updateData)
      .where(eq(tendersTable.id, id))
      .returning();

    if (!updated) { res.status(404).json({ error: "Opportunity not found" }); return; }

    // Re-score with updated metadata (deterministic, instant)
    try {
      await applyDeterministicScore(id);
    } catch (scoreErr) {
      req.log.warn({ err: scoreErr }, "Auto-score after update failed");
    }
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Error updating opportunity");
    res.status(500).json({ error: "Failed to update opportunity" });
  }
});

// ── Start bid: find-or-create proposal, mark tender as bid_started ────────────
router.post("/opportunities/:id/start-bid", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  try {
    const [tender] = await db.select().from(tendersTable).where(eq(tendersTable.id, id));
    if (!tender) { res.status(404).json({ error: "Tender not found" }); return; }

    // If tender already has a linked proposal, return it
    if (tender.proposalId) {
      const [existing] = await db
        .select({ id: proposalsTable.id })
        .from(proposalsTable)
        .where(eq(proposalsTable.id, tender.proposalId));
      if (existing) {
        res.json({ proposalId: existing.id, tenderId: id, existing: true });
        return;
      }
    }

    // Belt-and-suspenders: check proposals table by tenderId (unique constraint)
    const [existingByTender] = await db
      .select({ id: proposalsTable.id })
      .from(proposalsTable)
      .where(eq(proposalsTable.tenderId, id));
    if (existingByTender) {
      await db.update(tendersTable).set({
        proposalId: existingByTender.id,
        status:     tender.status === "bid_started" ? tender.status : "bid_started",
        updatedAt:  new Date(),
      }).where(eq(tendersTable.id, id));
      res.json({ proposalId: existingByTender.id, tenderId: id, existing: true });
      return;
    }

    // Create a new proposal from the tender's details
    const briefParts: string[] = [
      `Title: ${tender.title}`,
      `Client: ${tender.agency}`,
      `Category: ${tender.category}`,
    ];
    if (tender.deadline)    briefParts.push(`Deadline: ${new Date(tender.deadline).toDateString()}`);
    if (tender.valueAmount) briefParts.push(`Value: ${tender.valueAmount}`);
    briefParts.push("", tender.description);
    if (tender.rawText)     briefParts.push(`\nFull RFP:\n${tender.rawText}`);

    const [proposal] = await db
      .insert(proposalsTable)
      .values({
        clientName:      tender.agency,
        industry:        tender.category,
        status:          "draft",
        briefText:       briefParts.join("\n"),
        proposalContent: "",
        tenderId:        id,
      })
      .returning();

    await db.update(tendersTable).set({
      status:     "bid_started",
      proposalId: proposal.id,
      updatedAt:  new Date(),
    }).where(eq(tendersTable.id, id));

    res.json({ proposalId: proposal.id, tenderId: id, existing: false });
  } catch (err) {
    req.log.error({ err }, "Error starting bid");
    res.status(500).json({ error: "Failed to start bid" });
  }
});

// ── Trigger (or re-trigger) full analysis ────────────────────────────────────
// Returns 409 if an analysis is already running for this tender.
router.post("/opportunities/:id/analyze", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  try {
    const [tender] = await db
      .select({ id: tendersTable.id, status: tendersTable.status })
      .from(tendersTable)
      .where(eq(tendersTable.id, id));

    if (!tender) { res.status(404).json({ error: "Tender not found" }); return; }

    if (isActiveStatus(tender.status)) {
      res.status(409).json({
        error: `Analysis already running (step: ${tender.status}). Please wait for it to complete.`,
      });
      return;
    }

    // Generate runId here so the client can immediately use it to cancel
    const runId = crypto.randomUUID();
    res.json({ message: "Analysis started", analysisRunId: runId });
    void autoAnalyzeOpportunity(id, "requirements_extracting", runId);
  } catch (err) {
    req.log.error({ err }, "Error triggering analysis");
    res.status(500).json({ error: "Failed to start analysis" });
  }
});

// ── Cancel an in-progress analysis ───────────────────────────────────────────
// Body: { analysisRunId: string }
// Returns 200 when cancelled (or already terminal).
// Returns 409 when the runId doesn't match the current active run.
router.post("/opportunities/:id/cancel-analysis", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const { analysisRunId } = (req.body ?? {}) as { analysisRunId?: string };
  if (!analysisRunId) {
    res.status(400).json({ error: "analysisRunId is required" });
    return;
  }

  try {
    const [tender] = await db
      .select({ status: tendersTable.status, analysisRunId: tendersTable.analysisRunId })
      .from(tendersTable)
      .where(eq(tendersTable.id, id));

    if (!tender) { res.status(404).json({ error: "Tender not found" }); return; }

    // Already in a terminal state — run completed before cancel arrived
    if (!isActiveStatus(tender.status)) {
      res.json({ status: tender.status, alreadyCompleted: true });
      return;
    }

    // RunId mismatch — stale cancel request
    if (tender.analysisRunId !== analysisRunId) {
      res.status(409).json({ error: "analysisRunId does not match the current active run" });
      return;
    }

    // Abort the in-flight HTTP request
    const run = activeRuns.get(id);
    const interruptedStep = run?.step ?? (tender.status as string);
    if (run?.runId === analysisRunId) {
      run.controller.abort(new Error("Cancelled by user"));
      activeRuns.delete(id);
    }

    // Write cancellation to DB atomically (race-safe: only matches active statuses)
    const [updated] = await db.update(tendersTable).set({
      status:              "analysis_cancelled",
      cancelledAt:         new Date(),
      failedStep:          interruptedStep,
      analysisCompletedAt: new Date(),
      updatedAt:           new Date(),
    }).where(and(
      eq(tendersTable.id, id),
      eq(tendersTable.analysisRunId, analysisRunId),
      inArray(tendersTable.status, [...ANALYSIS_ACTIVE_STATUSES]),
    )).returning({ status: tendersTable.status });

    if (!updated) {
      // Race: pipeline completed between our read and write above
      const [fresh] = await db
        .select({ status: tendersTable.status })
        .from(tendersTable)
        .where(eq(tendersTable.id, id));
      res.json({ status: fresh?.status ?? "unknown", alreadyCompleted: true });
      return;
    }

    res.json({ message: "Analysis cancelled", status: "analysis_cancelled" });
  } catch (err) {
    req.log.error({ err }, "Error cancelling analysis");
    res.status(500).json({ error: "Failed to cancel analysis" });
  }
});

// ── Resume a cancelled or failed analysis ─────────────────────────────────────
// Reads completedSteps from DB and restarts from the first incomplete step.
router.post("/opportunities/:id/resume-analysis", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  try {
    const [tender] = await db
      .select({
        status:         tendersTable.status,
        completedSteps: tendersTable.completedSteps,
      })
      .from(tendersTable)
      .where(eq(tendersTable.id, id));

    if (!tender) { res.status(404).json({ error: "Tender not found" }); return; }

    if (isActiveStatus(tender.status)) {
      res.status(409).json({ error: "Analysis is already in progress" });
      return;
    }

    // Parse completed steps and find the first one to (re)run
    let completed: string[] = [];
    try { completed = JSON.parse(tender.completedSteps ?? "[]") as string[]; } catch { /* noop */ }

    // Check latest bid score for no_bid — skip strategy if so
    const [latestBid] = await db
      .select({ fitLevel: bidScoresTable.fitLevel })
      .from(bidScoresTable)
      .where(eq(bidScoresTable.tenderId, id))
      .orderBy(desc(bidScoresTable.createdAt))
      .limit(1);
    const isNoBid = latestBid?.fitLevel === "no_bid";

    const fromStep = getFirstIncompleteStep(completed, isNoBid);

    if (!fromStep) {
      res.json({ message: "All steps already completed", status: tender.status });
      return;
    }

    res.json({ message: "Resuming analysis", fromStep });
    void autoAnalyzeOpportunity(id, fromStep);
  } catch (err) {
    req.log.error({ err }, "Error resuming analysis");
    res.status(500).json({ error: "Failed to resume analysis" });
  }
});

// ── Extract requirements (manual trigger, single step only) ───────────────
router.post("/opportunities/:id/extract-requirements", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  try {
    const [tender] = await db
      .select({ status: tendersTable.status })
      .from(tendersTable)
      .where(eq(tendersTable.id, id));
    if (!tender) { res.status(404).json({ error: "Tender not found" }); return; }
    if (isActiveStatus(tender.status)) {
      res.status(409).json({ error: "Analysis already in progress for this tender." });
      return;
    }

    const inserted = await runExtractRequirements(id);
    if (inserted.length === 0) {
      res.status(400).json({ error: "Could not extract requirements from this opportunity" });
      return;
    }
    // Mark extracted
    await db
      .update(tendersTable)
      .set({ status: "requirements_extracted", updatedAt: new Date() })
      .where(eq(tendersTable.id, id));
    res.json({ requirements: inserted, count: inserted.length });
  } catch (err) {
    const { code, message } = classifyError(err);
    req.log.error({ err }, "Error extracting requirements");
    res.status(500).json({ error: "Failed to extract requirements", code, detail: message });
  }
});

// ── Score bid/no-bid (manual trigger) ─────────────────────────────────────
router.post("/opportunities/:id/score", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

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
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  try {
    const strategy = await runGenerateStrategy(id);
    res.json(strategy);
  } catch (err) {
    req.log.error({ err }, "Error generating strategy");
    res.status(500).json({ error: "Failed to generate strategy" });
  }
});

// ── Re-score existing items with keyword fallback ──────────────────────────
router.post("/tender-intelligence/rescore", async (req, res) => {
  try {
    const { rescoreWithKeywords } = await import("../crawlers/index.js");
    const count = await rescoreWithKeywords();
    res.json({ message: `Re-scored ${count} items using keyword engine`, count });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Generate section-based proposal ───────────────────────────────────────
router.post("/opportunities/:id/generate-proposal", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [tender] = await db.select().from(tendersTable).where(eq(tendersTable.id, id));
  if (!tender) { res.status(404).json({ error: "Opportunity not found" }); return; }

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
      clientName:      tender.agency,
      industry:        tender.category,
      briefText,
      proposalContent: "Generating proposal sections — please refresh in ~30 seconds.",
      status:          "proposal_drafting",
      tenderId:        id,
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
        title:      s.title,
        content:    "",
        status:     "not_started",
        orderIndex: s.order,
      })),
    )
    .returning();

  res.status(201).json({ proposal: draft, sections: sectionRows });

  void (async () => {
    try {
      const completion = await openai.chat.completions.create({
        model:                 AI_MODEL,
        max_tokens:            16000,
        response_format:       { type: "json_object" },
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
      const data = JSON.parse(raw) as { sections?: { key: string; content: string }[] };
      const sections: { key: string; content: string }[] = data.sections ?? [];

      const [genRun] = await db
        .insert(proposalGenerationRunsTable)
        .values({
          proposalId:            draft.id,
          model:                 AI_MODEL,
          promptVersion:         "2.0",
          retrievedKnowledgeIds: "[]",
          status:                "completed",
        })
        .returning();

      let combinedContent = "";
      for (const sectionDef of SECTION_DEFINITIONS) {
        const generated = sections.find((s) => s.key === sectionDef.key);
        const content    = generated?.content ?? `[NEEDS ONWRD INPUT: ${sectionDef.title} section not generated]`;
        const hasBlocker = content.includes("[NEEDS ONWRD INPUT");
        const status     = hasBlocker ? "blocked_missing_input" : "drafted";

        await db
          .update(proposalSectionsTable)
          .set({ content, status, generationRunId: genRun.id, updatedAt: new Date() })
          .where(and(
            eq(proposalSectionsTable.proposalId, draft.id),
            eq(proposalSectionsTable.sectionKey, sectionDef.key),
          ));

        combinedContent += `## ${sectionDef.title}\n\n${content}\n\n`;
      }

      const hasBlockedSections = sections.some((s) => s.content?.includes("[NEEDS ONWRD INPUT"));
      await db
        .update(proposalsTable)
        .set({
          proposalContent: combinedContent.trim(),
          status:          hasBlockedSections ? "needs_onwrd_input" : "ready_for_review",
          updatedAt:       new Date(),
        })
        .where(eq(proposalsTable.id, draft.id));

      await db
        .update(tendersTable)
        .set({
          status:    hasBlockedSections ? "needs_onwrd_input" : "ready_for_review",
          updatedAt: new Date(),
        })
        .where(eq(tendersTable.id, id));
    } catch (err) {
      console.error("[opportunity→proposal] generation failed:", err);
      await db
        .update(proposalsTable)
        .set({
          proposalContent: `Generation failed. Please regenerate.\n\nOriginal brief:\n${briefText}`,
          status:          "draft",
          updatedAt:       new Date(),
        })
        .where(eq(proposalsTable.id, draft.id));
    }
  })();
});

// ── Manual tender import ───────────────────────────────────────────────────
const manualUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 50 * 1024 * 1024 },
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
  const file    = req.file ?? null;

  if (!file && !bodyUrl) {
    res.status(400).json({ error: "Provide a file (.pdf, .docx, .txt) or a URL." });
    return;
  }

  try {
    let rawText  = "";
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
        hostname === "localhost" || hostname === "0.0.0.0" ||
        /^127\./.test(hostname) || /^10\./.test(hostname) ||
        /^192\.168\./.test(hostname) ||
        /^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname) ||
        /^169\.254\./.test(hostname) ||
        hostname === "::1" || hostname.endsWith(".local") || hostname.endsWith(".internal");
      if (blocked) {
        res.status(400).json({ error: "That URL resolves to a private or internal address and cannot be fetched." });
        return;
      }
      sourceUrl = bodyUrl;
      let html = "";
      try {
        const resp = await fetch(bodyUrl, {
          signal:  AbortSignal.timeout(15_000),
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
        .replace(/\s{2,}/g, " ")
        .trim();
    }

    if (!rawText || rawText.length < 50) {
      res.status(400).json({ error: "Could not extract enough text from the provided source." });
      return;
    }

    // Use AI to extract title, agency, etc. from the raw document text
    const extractCompletion = await openai.chat.completions.create({
      model: AI_MODEL,
      max_completion_tokens: 500,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Extract structured tender metadata from the document text. Return JSON:
{
  "title": string (tender/RFP title, max 200 chars),
  "agency": string (issuing organisation, max 150 chars),
  "description": string (scope/objective summary, max 1000 chars),
  "category": string (e.g. "Marketing", "Communications", "IT", "Construction"),
  "deadline": string | null (ISO date if found, else null),
  "valueAmount": string | null (contract value if stated, else null),
  "contactInfo": string | null
}`,
        },
        {
          role: "user",
          content: `Extract metadata from this tender document:\n\n${rawText.slice(0, 8000)}`,
        },
      ],
    });

    const metaRaw  = extractCompletion.choices[0]?.message?.content ?? "{}";
    const meta     = JSON.parse(metaRaw) as {
      title?: string; agency?: string; description?: string; category?: string;
      deadline?: string | null; valueAmount?: string | null; contactInfo?: string | null;
    };

    if (!meta.title || !meta.agency) {
      res.status(400).json({ error: "Could not identify a tender title or issuing agency in the document." });
      return;
    }

    const [created] = await db
      .insert(tendersTable)
      .values({
        title:       meta.title.slice(0, 200),
        agency:      meta.agency.slice(0, 150),
        description: meta.description?.slice(0, 2000) ?? rawText.slice(0, 500),
        category:    meta.category ?? "General",
        deadline:    meta.deadline ? new Date(meta.deadline) : null,
        valueAmount: meta.valueAmount ?? null,
        sourceUrl:   sourceUrl ?? null,
        contactInfo: meta.contactInfo ?? null,
        rawText,
        status:      "opportunity_found",
        recommendationScore: 0,
      })
      .returning();

    res.status(201).json(created);
    void autoAnalyzeOpportunity(created.id);
  } catch (err) {
    req.log.error({ err }, "[tenders/manual] import failed");
    res.status(500).json({ error: `Import failed: ${(err as Error).message}` });
  }
});

// ── Import tenders from CSV ───────────────────────────────────────────────
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }).single("file");

router.post("/tenders/import-csv", (req, res, next) => {
  csvUpload(req, res, (err: unknown) => {
    if (err) { res.status(400).json({ error: (err as Error).message }); return; }
    next();
  });
}, async (req, res) => {
  const file = req.file;
  if (!file) { res.status(400).json({ error: "No file uploaded" }); return; }

  try {
    const csv    = file.buffer.toString("utf-8");
    const lines  = csv.split("\n").filter((l) => l.trim());
    const header = lines[0]?.split(",").map((h) => h.trim().toLowerCase().replace(/"/g, "")) ?? [];
    const rows   = lines.slice(1);

    const idx = (field: string) => header.indexOf(field);

    const parse = (row: string): string[] => {
      const result: string[] = [];
      let cur = "";
      let inQuotes = false;
      for (const ch of row) {
        if (ch === '"') { inQuotes = !inQuotes; continue; }
        if (ch === "," && !inQuotes) { result.push(cur.trim()); cur = ""; continue; }
        cur += ch;
      }
      result.push(cur.trim());
      return result;
    };

    let created = 0;
    for (const row of rows) {
      const cells = parse(row);
      const title = cells[idx("title")]?.trim();
      const agency = cells[idx("agency")]?.trim();
      const description = cells[idx("description")]?.trim();
      if (!title || !agency || !description) continue;

      const rawDeadline = cells[idx("deadline")]?.trim();
      const deadline = rawDeadline ? new Date(rawDeadline) : null;

      const [inserted] = await db
        .insert(tendersTable)
        .values({
          title,
          agency,
          description,
          category:    cells[idx("category")]?.trim()     || "General",
          valueAmount: cells[idx("valueamount")]?.trim()  || null,
          sourceUrl:   cells[idx("sourceurl")]?.trim()    || null,
          contactInfo: cells[idx("contactinfo")]?.trim()  || null,
          deadline:    deadline && !isNaN(deadline.getTime()) ? deadline : null,
          status:      "opportunity_found",
          recommendationScore: 0,
        })
        .returning();

      created++;
      void autoAnalyzeOpportunity(inserted.id);
    }

    res.json({ message: `Imported ${created} tender(s)`, count: created });
  } catch (err) {
    req.log.error({ err }, "CSV import failed");
    res.status(500).json({ error: "CSV import failed" });
  }
});

// ── Extract tender from pasted text ───────────────────────────────────────
router.post("/tenders/extract-text", async (req, res) => {
  const { text } = req.body as { text?: string };
  if (!text || text.trim().length < 20) {
    res.status(400).json({ error: "Provide at least 20 characters of tender text." });
    return;
  }

  try {
    const completion = await openai.chat.completions.create({
      model: AI_MODEL,
      max_completion_tokens: 600,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `Extract structured tender metadata from the pasted text. Return JSON:
{
  "title": string,
  "agency": string,
  "description": string (scope summary ≤ 800 chars),
  "category": string,
  "deadline": string | null (ISO date),
  "valueAmount": string | null,
  "contactInfo": string | null,
  "sourceUrl": string | null
}`,
        },
        { role: "user", content: text.slice(0, 6000) },
      ],
    });

    const raw  = completion.choices[0]?.message?.content ?? "{}";
    const data = JSON.parse(raw) as {
      title?: string; agency?: string; description?: string; category?: string;
      deadline?: string | null; valueAmount?: string | null;
      contactInfo?: string | null; sourceUrl?: string | null;
    };

    if (!data.title || !data.agency) {
      res.status(400).json({ error: "Could not identify title/agency in the text." });
      return;
    }

    const [created] = await db
      .insert(tendersTable)
      .values({
        title:       data.title,
        agency:      data.agency,
        description: data.description ?? text.slice(0, 800),
        category:    data.category    ?? "General",
        deadline:    data.deadline    ? new Date(data.deadline) : null,
        valueAmount: data.valueAmount ?? null,
        sourceUrl:   data.sourceUrl   ?? null,
        contactInfo: data.contactInfo ?? null,
        rawText:     text,
        status:      "opportunity_found",
        recommendationScore: 0,
      })
      .returning();

    res.status(201).json(created);
    void autoAnalyzeOpportunity(created.id);
  } catch (err) {
    req.log.error({ err }, "Text extraction failed");
    res.status(500).json({ error: "Text extraction failed" });
  }
});

// ── Delete tender ──────────────────────────────────────────────────────────
router.delete("/opportunities/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  await db.delete(tendersTable).where(eq(tendersTable.id, id));
  res.status(204).end();
});

// ── Generate bid proposal (Google Doc) ────────────────────────────────────
router.post("/opportunities/:id/generate-bid", async (req, res) => {
  const opportunityId = Number(req.params.id);
  if (isNaN(opportunityId)) { res.status(400).json({ error: "Invalid id" }); return; }

  try {
    const [tender] = await db
      .select()
      .from(tendersTable)
      .where(eq(tendersTable.id, opportunityId));
    if (!tender) { res.status(404).json({ error: "Tender not found" }); return; }

    const requirements = await db
      .select()
      .from(tenderRequirementsTable)
      .where(eq(tenderRequirementsTable.tenderId, opportunityId))
      .orderBy(tenderRequirementsTable.orderIndex);

    const [strategy] = await db
      .select()
      .from(proposalStrategiesTable)
      .where(eq(proposalStrategiesTable.tenderId, opportunityId))
      .orderBy(desc(proposalStrategiesTable.createdAt))
      .limit(1);

    const requirementsText =
      requirements.length > 0
        ? requirements
            .map((r, i) => `${i + 1}. [${r.category}${r.isMandatory ? ", MANDATORY" : ""}] ${r.requirementText}`)
            .join("\n")
        : "No specific requirements extracted.";

    const strategyText = strategy
      ? `Positioning: ${strategy.positioning}\nWin Themes: ${JSON.parse(strategy.winThemes ?? "[]").join(", ")}\nMessaging: ${strategy.messagingGuidance}`
      : "";

    const proposalCompletion = await openai.chat.completions.create({
      model: AI_MODEL,
      max_completion_tokens: 4000,
      messages: [
        {
          role: "system",
          content: `You are a senior proposal writer at ONWRD. Write a complete bid proposal as a structured document. Use clear headings and professional language. ${ONWRD_CASE_STUDIES}`,
        },
        {
          role: "user",
          content: `Write a complete bid proposal for:\n\nTitle: ${tender.title}\nAgency: ${tender.agency}\nDeadline: ${tender.deadline ? new Date(tender.deadline).toDateString() : "Not specified"}\nValue: ${tender.valueAmount ?? "Not specified"}\n\nScope:\n${tender.description}\n\nRequirements:\n${requirementsText}\n\nStrategy:\n${strategyText}`,
        },
      ],
    });

    const proposalContent = proposalCompletion.choices[0]?.message?.content ?? "";
    const docTitle = `ONWRD Bid — ${tender.title}`.slice(0, 100);

    const { createGoogleDoc } = await import("../lib/google-docs.js");
    const { docId, docUrl } = await createGoogleDoc(docTitle, proposalContent);

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
