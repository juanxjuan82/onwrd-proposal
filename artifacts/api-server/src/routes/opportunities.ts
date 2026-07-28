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
  proposalStrategiesTable,
} from "@workspace/db";
import { eq, desc, and, inArray, sql } from "drizzle-orm";
import { invokeAI, type AIResult } from "../lib/ai-gateway.js";
import { extractTenderMetadata } from "../lib/metadata-extractor.js";
import { ONWRD_CASE_STUDIES } from "../lib/onwrd-case-studies.js";
import { applyDeterministicScore } from "../lib/apply-deterministic-score.js";
import {
  SECTION_DEFINITIONS,
  buildBriefText,
  buildStrategyContext,
  generateProposalDraftAndPersist,
} from "../lib/proposal-draft-service.js";
import {
  truncateToTokenBudget,
  classifyError,
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

// SECTION_DEFINITIONS imported from ../lib/proposal-draft-service.js

// ── Helper: check whether a tender is already being analysed ─────────────────
function isActiveStatus(status: string): status is AnalysisActiveStatus {
  return (ANALYSIS_ACTIVE_STATUSES as readonly string[]).includes(status);
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

  let aiResult: AIResult;
  try {
    aiResult = await invokeAI({
      feature: "requirements_extraction",
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
      maxTokens:      EXTRACTION_MAX_TOKENS,
      responseFormat: { type: "json_object" },
      signal,
      permitRetry:    true,
      opportunityId:  tenderId,
    });
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
  await db
    .update(tendersTable)
    .set({
      aiModelUsed:    aiResult.model,
      aiInputTokens:  (tender.aiInputTokens  ?? 0) + (aiResult.usage?.promptTokens     ?? 0),
      aiOutputTokens: (tender.aiOutputTokens ?? 0) + (aiResult.usage?.completionTokens ?? 0),
      updatedAt:      new Date(),
    })
    .where(eq(tendersTable.id, tenderId));

  // Parse and validate response
  const raw = aiResult.content;
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
  return applyDeterministicScore(db, tenderId);
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

  let raw: string;
  try {
    const stratResult = await invokeAI({
      feature: "strategy_generation",
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
      maxTokens:      2000,
      responseFormat: { type: "json_object" },
      signal,
      permitRetry:    true,
      opportunityId:  tenderId,
    });
    raw = stratResult.content;
  } catch (err) {
    if (cancelSignal?.aborted) {
      const e = new Error("Analysis cancelled by user"); e.name = "CancelledError"; throw e;
    }
    if (timeoutSignal.aborted || (err instanceof Error && err.name === "AbortError")) {
      throw new Error("AI request timed out after 90s");
    }
    throw err;
  }
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

// ── Extraction-only pipeline ─────────────────────────────────────────────────
// Requirements extracting → bid_scoring → requirements_extracted (or no_bid).
// Does NOT run strategy generation — that is a separate explicit user action.
async function runExtractionPipeline(
  tenderId: number,
  runId: string = crypto.randomUUID(),
): Promise<void> {
  const controller = new AbortController();
  const { signal } = controller;

  const [current] = await db
    .select({ status: tendersTable.status })
    .from(tendersTable)
    .where(eq(tendersTable.id, tenderId));
  if (!current) return;
  if (isActiveStatus(current.status)) {
    console.warn(`[extraction] Tender ${tenderId} already in status "${current.status}" — skipping`);
    return;
  }

  activeRuns.set(tenderId, { runId, controller, step: "requirements_extracting" });

  const fail = async (step: string, err: unknown): Promise<void> => {
    activeRuns.delete(tenderId);
    const { code } = classifyError(err);
    console.error(
      `[extraction] tender=${tenderId} step="${step}" code=${code}:`,
      (err instanceof Error ? err.message : String(err)).slice(0, 200),
    );
    await db.update(tendersTable).set({
      status:              "analysis_failed",
      failedStep:          step,
      failedErrorCode:     code,
      analysisCompletedAt: new Date(),
      updatedAt:           new Date(),
    }).where(and(eq(tendersTable.id, tenderId), eq(tendersTable.analysisRunId, runId)));
  };

  await db.update(tendersTable).set({
    status:              "requirements_extracting",
    analysisRunId:       runId,
    analysisStartedAt:   new Date(),
    aiInputTokens:       0,
    aiOutputTokens:      0,
    analysisCompletedAt: null,
    cancelledAt:         null,
    failedStep:          null,
    failedErrorCode:     null,
    aiModelUsed:         null,
    completedSteps:      JSON.stringify([]),
    updatedAt:           new Date(),
  }).where(eq(tendersTable.id, tenderId));

  // ① Requirements extraction (AI)
  if (signal.aborted) { activeRuns.delete(tenderId); return; }
  try {
    await runExtractRequirements(tenderId, signal);
  } catch (err) {
    if (signal.aborted) { activeRuns.delete(tenderId); return; }
    await fail("requirements_extracting", err);
    return;
  }

  const [advancedToBidScoring] = await db.update(tendersTable).set({
    status:         "bid_scoring",
    completedSteps: JSON.stringify(["requirements_extracting"]),
    updatedAt:      new Date(),
  }).where(and(
    eq(tendersTable.id, tenderId),
    eq(tendersTable.analysisRunId, runId),
    eq(tendersTable.status, "requirements_extracting"),
  )).returning({ id: tendersTable.id });
  if (!advancedToBidScoring) { activeRuns.delete(tenderId); return; } // cancelled
  if (signal.aborted) { activeRuns.delete(tenderId); return; }

  // ② Bid scoring (deterministic — no AI)
  activeRuns.get(tenderId)!.step = "bid_scoring";
  let bidScore: Awaited<ReturnType<typeof runBidScoring>>;
  try {
    bidScore = await runBidScoring(tenderId, signal);
  } catch (err) {
    if (signal.aborted) { activeRuns.delete(tenderId); return; }
    await fail("bid_scoring", err);
    return;
  }

  const completedSteps = ["requirements_extracting", "bid_scoring"];
  activeRuns.delete(tenderId);

  if (bidScore.fitLevel === "no_bid") {
    await db.update(tendersTable).set({
      status:              "no_bid",
      analysisCompletedAt: new Date(),
      completedSteps:      JSON.stringify(completedSteps),
      updatedAt:           new Date(),
    }).where(and(eq(tendersTable.id, tenderId), eq(tendersTable.analysisRunId, runId)));
    return;
  }

  await db.update(tendersTable).set({
    status:              "requirements_extracted",
    analysisCompletedAt: new Date(),
    completedSteps:      JSON.stringify(completedSteps),
    updatedAt:           new Date(),
  }).where(and(eq(tendersTable.id, tenderId), eq(tendersTable.analysisRunId, runId)));
}

// ── Bounded strategy generation ───────────────────────────────────────────────
// Separate explicit action — never triggered automatically.
// requirements_extracted → strategy_generating → screened.
async function runBoundedStrategy(
  tenderId: number,
  runId: string,
): Promise<void> {
  const controller = new AbortController();
  const { signal } = controller;

  const [current] = await db
    .select({ status: tendersTable.status, completedSteps: tendersTable.completedSteps })
    .from(tendersTable)
    .where(eq(tendersTable.id, tenderId));
  if (!current) return;
  if (isActiveStatus(current.status)) {
    console.warn(`[strategy] Tender ${tenderId} already in status "${current.status}" — skipping`);
    return;
  }

  activeRuns.set(tenderId, { runId, controller, step: "strategy_generating" });

  const fail = async (err: unknown): Promise<void> => {
    activeRuns.delete(tenderId);
    const { code } = classifyError(err);
    console.error(
      `[strategy] tender=${tenderId} code=${code}:`,
      (err instanceof Error ? err.message : String(err)).slice(0, 200),
    );
    await db.update(tendersTable).set({
      status:              "analysis_failed",
      failedStep:          "strategy_generating",
      failedErrorCode:     code,
      analysisCompletedAt: new Date(),
      updatedAt:           new Date(),
    }).where(and(eq(tendersTable.id, tenderId), eq(tendersTable.analysisRunId, runId)));
  };

  await db.update(tendersTable).set({
    status:              "strategy_generating",
    analysisRunId:       runId,
    analysisCompletedAt: null,
    cancelledAt:         null,
    failedStep:          null,
    failedErrorCode:     null,
    updatedAt:           new Date(),
  }).where(eq(tendersTable.id, tenderId));

  if (signal.aborted) { activeRuns.delete(tenderId); return; }

  try {
    await runGenerateStrategy(tenderId, signal);
  } catch (err) {
    if (signal.aborted) { activeRuns.delete(tenderId); return; }
    await fail(err);
    return;
  }

  activeRuns.delete(tenderId);

  let completed: string[] = [];
  try { completed = JSON.parse(current.completedSteps ?? "[]") as string[]; } catch { /* noop */ }
  completed = [...new Set([...completed, "strategy_generating"])];

  await db.update(tendersTable).set({
    status:              "screened",
    analysisCompletedAt: new Date(),
    completedSteps:      JSON.stringify(completed),
    updatedAt:           new Date(),
  }).where(and(eq(tendersTable.id, tenderId), eq(tendersTable.analysisRunId, runId)));
}

// ── List opportunities (with latest bid score per tender) ───────────────────
router.get("/opportunities", async (req, res) => {
  try {
    const { sourceType } = req.query as { sourceType?: string };
    const tenders = await db
      .select()
      .from(tendersTable)
      .where(sourceType ? eq(tendersTable.sourceType, sourceType) : undefined)
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
    deadline, valueAmount, sourceUrl, contactInfo, rawText, sourceType,
  } = req.body as {
    title: string; agency: string; description: string; category?: string;
    deadline?: string; valueAmount?: string; sourceUrl?: string;
    contactInfo?: string; rawText?: string; sourceType?: string;
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
        sourceType:  sourceType  ?? "manual",
        status:      "opportunity_found",
        recommendationScore: 0,
      })
      .returning();

    // Deterministic scoring — no AI call. Sets pending_review or no_bid.
    let finalStatus = "pending_review";
    try {
      const score = await applyDeterministicScore(db, created.id);
      finalStatus = score.fitLevel === "no_bid" ? "no_bid" : "pending_review";
    } catch (scoreErr) {
      req.log.warn({ err: scoreErr }, "Auto-score after create failed — retry via /score");
    }
    await db.update(tendersTable)
      .set({ status: finalStatus, updatedAt: new Date() })
      .where(eq(tendersTable.id, created.id));
    res.status(201).json({ ...created, status: finalStatus });
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
      await applyDeterministicScore(db, id);
    } catch (scoreErr) {
      req.log.warn({ err: scoreErr }, "Auto-score after update failed");
    }
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Error updating opportunity");
    res.status(500).json({ error: "Failed to update opportunity" });
  }
});

// ── REMOVED: start-bid ────────────────────────────────────────────────────────
// Replaced by the canonical pursue route. Returns 410 Gone.
router.post("/opportunities/:id/start-bid", (_req, res) => {
  res.status(410).json({ error: "Gone. Use POST /opportunities/:id/pursue to create a proposal." });
});

// ── REMOVED: convert ─────────────────────────────────────────────────────────
// Replaced by the canonical pursue route. Returns 410 Gone.
router.post("/opportunities/:id/convert", (_req, res) => {
  res.status(410).json({ error: "Gone. Use POST /opportunities/:id/pursue to create a proposal, then use proposal AI endpoints for generation." });
});

// ── Pursue: find-or-create proposal, mark tender bid_started (idempotent) ────
// Concurrent-safe: INSERT ... ON CONFLICT (tender_id) DO NOTHING so both
// concurrent callers attempt an insert, exactly one wins, and both then
// read the same canonical row.  No SELECT FOR UPDATE needed — the unique
// constraint on proposals.tender_id is the concurrency guard.
router.post("/opportunities/:id/pursue", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  try {
    type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
    const proposalId = await db.transaction(async (tx: DbTx) => {
      // 1. Verify the opportunity exists (plain SELECT — no lock needed)
      const tenderResult = await tx.execute(
        sql`SELECT id, title, agency, category, description, deadline,
                   value_amount, raw_text
            FROM tenders WHERE id = ${id}`,
      );
      const tender = tenderResult.rows[0] as {
        id: number; title: string; agency: string; category: string;
        description: string; deadline: string | null;
        value_amount: string | null; raw_text: string | null;
      } | undefined;
      if (!tender) {
        const e = new Error("NOT_FOUND");
        (e as NodeJS.ErrnoException).code = "NOT_FOUND";
        throw e;
      }

      // 2. Build brief text
      const briefParts: string[] = [tender.title, `Agency: ${tender.agency}`];
      if (tender.deadline)     briefParts.push(`Deadline: ${tender.deadline.slice(0, 10)}`);
      if (tender.value_amount) briefParts.push(`Value: ${tender.value_amount}`);
      briefParts.push("", tender.description);
      if (tender.raw_text)     briefParts.push(`\nFull RFP:\n${tender.raw_text}`);
      const briefText = briefParts.join("\n");

      // 3. Attempt insert — ON CONFLICT (tender_id) DO NOTHING is the
      //    concurrency guard.  Exactly one caller creates the row; the other
      //    silently skips.  Both then read the same canonical row below.
      await tx.execute(
        sql`INSERT INTO proposals (client_name, industry, status, brief_text, proposal_content, tender_id)
            VALUES (${tender.agency}, ${tender.category}, 'draft', ${briefText}, '', ${id})
            ON CONFLICT (tender_id) DO NOTHING`,
      );

      // 4. Fetch the canonical proposal (same row for every concurrent caller)
      const canonicalResult = await tx.execute(
        sql`SELECT id FROM proposals WHERE tender_id = ${id} LIMIT 1`,
      );
      const canonical = canonicalResult.rows[0] as { id: number } | undefined;
      if (!canonical) throw new Error("Proposal not found after concurrent-safe insert");

      // 5. Mark Opportunity as bid_started
      await tx.execute(
        sql`UPDATE tenders SET status = 'bid_started', updated_at = NOW() WHERE id = ${id}`,
      );

      return canonical.id;
    });

    res.json({ proposalId });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "NOT_FOUND") {
      res.status(404).json({ error: "Opportunity not found" });
      return;
    }
    req.log.error({ err }, "Error pursuing opportunity");
    res.status(500).json({ error: "Failed to pursue opportunity" });
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
    void runExtractionPipeline(id, runId);
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

    res.json({ message: "Use explicit step endpoints to continue analysis", fromStep });
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

// ── Opportunity readiness — prerequisites for proposal workflow steps ────────
// Returns persisted facts about requirements, strategy, and tender state.
// No mutations — safe to poll frequently.
router.get("/opportunities/:id/readiness", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  try {
    const [tender] = await db
      .select({ status: tendersTable.status })
      .from(tendersTable)
      .where(eq(tendersTable.id, id));

    if (!tender) { res.status(404).json({ error: "Opportunity not found" }); return; }

    const [reqCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(tenderRequirementsTable)
      .where(eq(tenderRequirementsTable.tenderId, id));

    const [strategy] = await db
      .select({ id: proposalStrategiesTable.id })
      .from(proposalStrategiesTable)
      .where(eq(proposalStrategiesTable.tenderId, id))
      .orderBy(desc(proposalStrategiesTable.createdAt))
      .limit(1);

    const requirementsCount = reqCount?.count ?? 0;

    res.json({
      tenderStatus:         tender.status,
      isActive:             isActiveStatus(tender.status),
      requirementsCount,
      requirementsComplete: requirementsCount > 0,
      strategyComplete:     !!strategy,
    });
  } catch (err) {
    req.log.error({ err }, "Error getting opportunity readiness");
    res.status(500).json({ error: "Failed to get readiness" });
  }
});

// ── Generate strategy brief (explicit user action) ─────────────────────────
// AI-powered; requires requirements to be available. Bounded execution
// with timeout, abort signal, and cancellation support (same as analysis).
router.post("/opportunities/:id/generate-strategy", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  try {
    const [tender] = await db
      .select({ id: tendersTable.id, status: tendersTable.status })
      .from(tendersTable)
      .where(eq(tendersTable.id, id));
    if (!tender) { res.status(404).json({ error: "Opportunity not found" }); return; }

    if (isActiveStatus(tender.status)) {
      res.status(409).json({
        error: `Analysis already running (step: ${tender.status}). Please wait.`,
      });
      return;
    }

    const runId = crypto.randomUUID();
    res.json({ message: "Strategy generation started", analysisRunId: runId });
    void runBoundedStrategy(id, runId);
  } catch (err) {
    req.log.error({ err }, "Error starting strategy generation");
    res.status(500).json({ error: "Failed to start strategy generation" });
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

  // ── Resolve canonical proposal ────────────────────────────────────────────
  // A tender has at most one proposal (unique constraint on tender_id).
  // Never create a second proposal row — find or create the canonical one.
  const requestedProposalId = req.body?.proposalId ? Number(req.body.proposalId) : null;

  // Validate a supplied proposalId up-front: must be a positive integer.
  if (requestedProposalId !== null && (isNaN(requestedProposalId) || requestedProposalId <= 0)) {
    res.status(400).json({ error: "Invalid proposalId", code: "invalid_proposal_id" });
    return;
  }

  // ── Atomic acquisition ─────────────────────────────────────────────────────────────────────
  // All concurrency guarding happens inside ONE transaction:
  //   1. INSERT … ON CONFLICT DO NOTHING (ensure canonical row exists)
  //   2. SELECT … FOR UPDATE (acquire row lock — blocks concurrent requests)
  //   3. Validate the caller’s proposalId
  //   4. Check for active (non-stale) generation
  //   5. Atomically claim generation (set proposal_drafting + updated_at)
  //   6. Reset sections
  // A second concurrent request blocks on step 2, then sees proposal_drafting in
  // step 4 and returns 409. Zero AI calls are launched by the second request.

  const STALE_GENERATION_MS = 5 * 60 * 1000; // 5 minutes

  type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

  let draft: { id: number; [k: string]: unknown };
  let sectionRows: Record<string, unknown>[];

  try {
    const result = await db.transaction(async (tx: DbTx) => {
      // 1. Ensure canonical row exists — ON CONFLICT DO NOTHING is race-safe
      await tx.execute(sql`
        INSERT INTO proposals
          (client_name, industry, brief_text, proposal_content, status, tender_id, created_at, updated_at)
        VALUES (
          ${tender.agency},
          ${tender.category},
          ${briefText},
          ${""},
          ${"draft"},
          ${id},
          NOW(), NOW()
        )
        ON CONFLICT (tender_id) DO NOTHING
      `);

      // 2. Acquire the row lock — blocks concurrent requests until we commit
      const lockedResult = await tx.execute(sql`
        SELECT id, status, updated_at, sync_status, google_file_id, google_doc_url
        FROM proposals
        WHERE tender_id = ${id}
        FOR UPDATE
      `);
      const locked = lockedResult.rows[0] as {
        id: number;
        status: string;
        updated_at: string | null;
        sync_status: string | null;
        google_file_id: string | null;
        google_doc_url: string | null;
      } | undefined;

      if (!locked) throw new Error("Proposal row missing after concurrent-safe insert");

      // 3. Validate the caller’s proposalId
      if (requestedProposalId !== null && locked.id !== requestedProposalId) {
        const e = new Error("MISMATCH");
        (e as NodeJS.ErrnoException).code = "MISMATCH";
        throw e;
      }

      // 3.5. Block regeneration when proposal is already a canonical Google Doc.
      //      Once a proposal is in Google Docs it is the source of truth.
      {
        const isHandoffComplete = locked.sync_status === "handoff_complete";
        const isLegacyLinked =
          !!locked.google_file_id &&
          locked.sync_status !== "pending_first_write" &&
          locked.sync_status !== "handoff_in_progress" &&
          !isHandoffComplete;
        if (isHandoffComplete || isLegacyLinked) {
          const e = new Error("GOOGLE_DOC_CANONICAL") as NodeJS.ErrnoException & { googleDocUrl?: string };
          e.code = "GOOGLE_DOC_CANONICAL";
          e.googleDocUrl =
            locked.google_doc_url ??
            (locked.google_file_id
              ? `https://docs.google.com/document/d/${locked.google_file_id}/edit`
              : undefined);
          throw e;
        }
      }

      // 4. Active-generation check with stale-recovery timeout
      if (locked.status === "proposal_drafting") {
        const startedAt = locked.updated_at ? new Date(locked.updated_at).getTime() : 0;
        if (Date.now() - startedAt < STALE_GENERATION_MS) {
          const e = new Error("IN_PROGRESS");
          (e as NodeJS.ErrnoException).code = "IN_PROGRESS";
          throw e;
        }
        // Stale generation (> 5 min) — fall through and re-generate
      }

      // 5. Atomically claim generation
      const now = new Date();
      const [updated] = await tx
        .update(proposalsTable)
        .set({
          clientName:      tender.agency,
          industry:        tender.category,
          briefText,
          proposalContent: "Generating proposal sections — please refresh in ~30 seconds.",
          status:          "proposal_drafting",
          updatedAt:       now,
        })
        .where(eq(proposalsTable.id, locked.id))
        .returning();

      // 6. Keep tender linked to the canonical proposal
      await tx
        .update(tendersTable)
        .set({ proposalId: locked.id, status: "proposal_drafting", updatedAt: now })
        .where(eq(tendersTable.id, id));

      // 7. Reset section rows idempotently — delete stale shells, insert fresh ones
      await tx.execute(sql`DELETE FROM proposal_sections WHERE proposal_id = ${locked.id}`);

      const sections = await tx
        .insert(proposalSectionsTable)
        .values(
          SECTION_DEFINITIONS.map((s) => ({
            proposalId: locked.id,
            sectionKey: s.key,
            title:      s.title,
            content:    "",
            status:     "not_started",
            orderIndex: s.order,
          })),
        )
        .returning();

      return { draft: updated as { id: number; [k: string]: unknown }, sectionRows: sections };
    });

    draft = result.draft;
    sectionRows = result.sectionRows as typeof sectionRows;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "MISMATCH") {
      res.status(409).json({
        error: "proposalId does not belong to this opportunity",
        code:  "proposal_mismatch",
      });
      return;
    }
    if ((err as NodeJS.ErrnoException).code === "IN_PROGRESS") {
      res.status(409).json({
        error: "Generation is already in progress for this proposal.",
        code:  "generation_in_progress",
      });
      return;
    }
    if ((err as NodeJS.ErrnoException).code === "GOOGLE_DOC_CANONICAL") {
      const e = err as NodeJS.ErrnoException & { googleDocUrl?: string };
      res.status(409).json({
        error:       "google_doc_canonical",
        code:        "google_doc_canonical",
        googleDocUrl: e.googleDocUrl,
      });
      return;
    }
    req.log.error({ err }, "Error in generate-proposal transaction");
    res.status(500).json({ error: "Failed to start proposal generation" });
    return;
  }

  res.status(200).json({ proposalId: draft.id, proposal: draft, sections: sectionRows });

  void (async () => {
    try {
      // Shared draft service: AI call outside transaction, atomic section persist inside.
      await generateProposalDraftAndPersist({
        tenderId:        id,
        proposalId:      draft.id,
        briefText,
        strategyContext,
      });
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

// ── Full generation pipeline (extract → strategy → draft) ────────────────
// Returns 202 immediately. Background chaining handles all three phases with
// phase-skip via persisted completion evidence (Task #32).

const FULL_GEN_STALE_MS = 5 * 60 * 1000; // 5 minutes

async function runFullGenerationBackground(
  tenderId: number,
  proposalId: number,
): Promise<void> {
  const setGenStatus = async (status: string) => {
    await db.execute(
      sql`UPDATE proposals SET generation_status = ${status}, updated_at = NOW() WHERE id = ${proposalId}`,
    );
  };

  const fail = async (err: unknown) => {
    const { code } = classifyError(err);
    console.error(
      `[full-gen] proposal=${proposalId} code=${code}:`,
      (err instanceof Error ? err.message : String(err)).slice(0, 200),
    );
    await db.execute(
      sql`UPDATE proposals SET generation_status = 'failed', status = 'draft', updated_at = NOW() WHERE id = ${proposalId}`,
    );
  };

  try {
    // Phase 1: Requirements extraction — skip if persisted evidence exists
    const [reqCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(tenderRequirementsTable)
      .where(eq(tenderRequirementsTable.tenderId, tenderId));
    const [tenderMeta] = await db
      .select({ requirementsExtractedAt: tendersTable.requirementsExtractedAt })
      .from(tendersTable)
      .where(eq(tendersTable.id, tenderId));
    const extractionComplete =
      (reqCount?.count ?? 0) > 0 && !!tenderMeta?.requirementsExtractedAt;

    if (!extractionComplete) {
      const inserted = await runExtractRequirements(tenderId);
      if (inserted.length === 0) {
        throw new Error("NO_REQUIREMENTS_EXTRACTED");
      }
    }

    // Phase 2: Strategy generation — skip if strategy row exists
    await setGenStatus("strategizing");

    const [existingStrategy] = await db
      .select({ id: proposalStrategiesTable.id })
      .from(proposalStrategiesTable)
      .where(eq(proposalStrategiesTable.tenderId, tenderId))
      .orderBy(desc(proposalStrategiesTable.createdAt))
      .limit(1);

    if (!existingStrategy) {
      await runGenerateStrategy(tenderId);
    }

    // Phase 3: Proposal draft — reload everything freshly after prior phases
    await setGenStatus("drafting");

    const [tender] = await db.select().from(tendersTable).where(eq(tendersTable.id, tenderId));
    if (!tender) throw new Error(`Tender ${tenderId} not found during full-gen draft phase`);

    const requirements = await db
      .select()
      .from(tenderRequirementsTable)
      .where(eq(tenderRequirementsTable.tenderId, tenderId))
      .orderBy(tenderRequirementsTable.orderIndex);

    const [latestStrategy] = await db
      .select()
      .from(proposalStrategiesTable)
      .where(eq(proposalStrategiesTable.tenderId, tenderId))
      .orderBy(desc(proposalStrategiesTable.createdAt))
      .limit(1);

    // Shared draft service: AI call outside transaction, atomic section + snapshot inside.
    // Prior section content is preserved if the AI call or transaction fails.
    await generateProposalDraftAndPersist({
      tenderId,
      proposalId,
      briefText:       buildBriefText(tender, requirements),
      strategyContext: buildStrategyContext(latestStrategy),
    });

    // Mark orchestration complete
    await setGenStatus("ready");

  } catch (err) {
    await fail(err);
  }
}

router.post("/opportunities/:id/run-full-generation", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [tender] = await db.select().from(tendersTable).where(eq(tendersTable.id, id));
  if (!tender) { res.status(404).json({ error: "Opportunity not found" }); return; }

  const initBriefText = `TENDER OPPORTUNITY — ${tender.title}

Issuing Agency: ${tender.agency}
Category: ${tender.category}
${tender.deadline ? `Submission Deadline: ${new Date(tender.deadline).toDateString()}` : ""}
${tender.valueAmount ? `Estimated Value: ${tender.valueAmount}` : ""}

SCOPE / DESCRIPTION:
${tender.description}`;

  type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

  let proposalId: number;
  let currentGenStatus: string;

  try {
    const result = await db.transaction(async (tx: DbTx) => {
      // 1. Ensure canonical proposal row exists — ON CONFLICT DO NOTHING is race-safe
      await tx.execute(sql`
        INSERT INTO proposals (client_name, industry, brief_text, proposal_content, status, tender_id, created_at, updated_at)
        VALUES (${tender.agency}, ${tender.category}, ${initBriefText}, ${""},  ${"draft"}, ${id}, NOW(), NOW())
        ON CONFLICT (tender_id) DO NOTHING
      `);

      // 2. Lock the row
      const lockedResult = await tx.execute(sql`
        SELECT id, status, generation_status, updated_at, sync_status, google_file_id, google_doc_url
        FROM proposals WHERE tender_id = ${id} FOR UPDATE
      `);
      const locked = lockedResult.rows[0] as {
        id: number;
        status: string;
        generation_status: string | null;
        updated_at: string | null;
        sync_status: string | null;
        google_file_id: string | null;
        google_doc_url: string | null;
      } | undefined;
      if (!locked) throw new Error("Proposal row missing after concurrent-safe insert");

      // 3. Guard: don't overwrite a canonical Google Doc
      {
        const isHandoffComplete = locked.sync_status === "handoff_complete";
        const isLegacyLinked =
          !!locked.google_file_id &&
          locked.sync_status !== "pending_first_write" &&
          locked.sync_status !== "handoff_in_progress" &&
          !isHandoffComplete;
        if (isHandoffComplete || isLegacyLinked) {
          const e = new Error("GOOGLE_DOC_CANONICAL") as NodeJS.ErrnoException & { googleDocUrl?: string };
          e.code       = "GOOGLE_DOC_CANONICAL";
          e.googleDocUrl = locked.google_doc_url ?? (locked.google_file_id ? `https://docs.google.com/document/d/${locked.google_file_id}/edit` : undefined);
          throw e;
        }
      }

      // 4. If generation is active and not stale, return current status without relaunching
      const ACTIVE_GEN_STATUSES = ["extracting", "strategizing", "drafting"];
      if (ACTIVE_GEN_STATUSES.includes(locked.generation_status ?? "")) {
        const startedAt = locked.updated_at ? new Date(locked.updated_at).getTime() : 0;
        if (Date.now() - startedAt < FULL_GEN_STALE_MS) {
          return { proposalId: locked.id, generationStatus: locked.generation_status as string, alreadyRunning: true };
        }
      }

      // 4b. If draft is already complete with meaningful content, return without re-running
      if (locked.generation_status === "ready") {
        const countRes = await tx.execute(sql`
          SELECT count(*)::int AS count FROM proposal_sections
          WHERE proposal_id = ${locked.id} AND content <> ''
        `);
        const count = Number((countRes.rows[0] as { count: string } | undefined)?.count ?? 0);
        if (count > 0) {
          return { proposalId: locked.id, generationStatus: "ready", alreadyRunning: true };
        }
        // No meaningful content — fall through and re-generate
      }

      // 5. Claim generation — atomically set extracting + proposal_drafting
      await tx.execute(sql`
        UPDATE proposals
        SET generation_status = 'extracting',
            status            = 'proposal_drafting',
            client_name       = ${tender.agency},
            industry          = ${tender.category},
            brief_text        = ${initBriefText},
            updated_at        = NOW()
        WHERE id = ${locked.id}
      `);

      // 6. Link tender → proposal; mark tender as in-progress
      await tx.execute(sql`
        UPDATE tenders
        SET proposal_id = ${locked.id}, status = 'proposal_drafting', updated_at = NOW()
        WHERE id = ${id}
      `);

      // Note: section shells are NOT pre-seeded here.
      // The draft service creates sections atomically after AI output is validated,
      // preserving any prior content if the draft phase fails.

      return { proposalId: locked.id, generationStatus: "extracting", alreadyRunning: false };
    });

    proposalId      = result.proposalId;
    currentGenStatus = result.generationStatus;

    if (result.alreadyRunning) {
      res.status(202).json({ proposalId, generationStatus: currentGenStatus });
      return;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "GOOGLE_DOC_CANONICAL") {
      const e = err as NodeJS.ErrnoException & { googleDocUrl?: string };
      res.status(409).json({
        error:        "google_doc_canonical",
        code:         "google_doc_canonical",
        googleDocUrl: e.googleDocUrl,
      });
      return;
    }
    req.log.error({ err }, "Error in run-full-generation transaction");
    res.status(500).json({ error: "Failed to start generation" });
    return;
  }

  res.status(202).json({ proposalId, generationStatus: "extracting" });
  void runFullGenerationBackground(id, proposalId);
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

    const meta = extractTenderMetadata(rawText.slice(0, 8000));

    const [created] = await db
      .insert(tendersTable)
      .values({
        title:       (meta.title    ?? "Needs review — title not detected").slice(0, 200),
        agency:      (meta.agency   ?? "Needs review — agency not detected").slice(0, 150),
        description: (meta.description || rawText.slice(0, 500)).slice(0, 2000),
        category:    meta.category,
        deadline:    meta.deadline ? new Date(meta.deadline) : null,
        valueAmount: meta.valueAmount ?? null,
        sourceUrl:   sourceUrl ?? null,
        contactInfo: meta.contactInfo ?? null,
        rawText,
        status:      "opportunity_found",
        recommendationScore: 0,
      })
      .returning();

    // Deterministic scoring only — no AI call. Sets pending_review or no_bid.
    let manualStatus = "pending_review";
    try {
      const score = await applyDeterministicScore(db, created.id);
      manualStatus = score.fitLevel === "no_bid" ? "no_bid" : "pending_review";
    } catch (scoreErr) {
      req.log.warn({ err: scoreErr }, "[tenders/manual] auto-score failed");
    }
    await db.update(tendersTable)
      .set({ status: manualStatus, updatedAt: new Date() })
      .where(eq(tendersTable.id, created.id));
    res.status(201).json({ ...created, status: manualStatus });
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
          sourceType:  "csv",
          status:      "opportunity_found",
          recommendationScore: 0,
        })
        .returning();

      // Deterministic scoring only — no AI call
      try {
        const score = await applyDeterministicScore(db, inserted.id);
        const csvStatus = score.fitLevel === "no_bid" ? "no_bid" : "pending_review";
        await db.update(tendersTable)
          .set({ status: csvStatus, updatedAt: new Date() })
          .where(eq(tendersTable.id, inserted.id));
      } catch (scoreErr) {
        req.log.warn({ err: scoreErr }, "CSV auto-score failed for inserted tender");
      }
      created++;
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
    const meta = extractTenderMetadata(text.slice(0, 6000));

    const [created] = await db
      .insert(tendersTable)
      .values({
        title:       (meta.title    ?? "Needs review — title not detected").slice(0, 200),
        agency:      (meta.agency   ?? "Needs review — agency not detected").slice(0, 150),
        description: (meta.description || text.slice(0, 800)).slice(0, 2000),
        category:    meta.category,
        deadline:    meta.deadline    ? new Date(meta.deadline) : null,
        valueAmount: meta.valueAmount ?? null,
        sourceUrl:   null,
        contactInfo: meta.contactInfo ?? null,
        rawText:     text,
        sourceType:  "pasted_text",
        status:      "opportunity_found",
        recommendationScore: 0,
      })
      .returning();

    // Deterministic scoring only — no AI call. Sets pending_review or no_bid.
    let extractStatus = "pending_review";
    try {
      const score = await applyDeterministicScore(db, created.id);
      extractStatus = score.fitLevel === "no_bid" ? "no_bid" : "pending_review";
    } catch (scoreErr) {
      req.log.warn({ err: scoreErr }, "[extract-text] auto-score failed");
    }
    await db.update(tendersTable)
      .set({ status: extractStatus, updatedAt: new Date() })
      .where(eq(tendersTable.id, created.id));
    res.status(201).json({ ...created, status: extractStatus });
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

// ── Generate bid proposal (DEPRECATED) ────────────────────────────────────
// This endpoint previously created a Google Doc directly from the opportunity.
// It is replaced by the canonical pursue → proposal workflow:
//   POST /opportunities/:id/pursue  → creates a Proposal row
//   POST /proposals/:id/...         → AI generation steps on the Proposal
// Kept as 410 Gone to surface clear errors if any old client still calls it.
router.post("/opportunities/:id/generate-bid", (_req, res) => {
  res.status(410).json({
    error: "This endpoint is removed. Use POST /opportunities/:id/pursue to create a proposal, then use the proposal AI endpoints for generation.",
  });
});

export default router;
