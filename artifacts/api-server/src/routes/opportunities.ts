import { Router } from "express";
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
import { openai } from "@workspace/integrations-openai-ai-server";
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
    model: "gpt-5.2",
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
    model: "gpt-5.2",
    max_completion_tokens: 2000,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are a senior business development advisor at ONWRD, a full-service marketing and strategy agency in the Bahamas. You evaluate whether ONWRD should bid on a tender opportunity.

ONWRD's strengths: marketing strategy, brand identity, digital marketing, content development, website design, campaign management, social media, communications strategy. ONWRD works across the Caribbean region, particularly the Bahamas. ONWRD is a mid-size boutique agency — not suitable for very large infrastructure or construction tenders.

Evaluate the tender and return JSON with:
- fitScore: integer 0-100 (how well ONWRD fits this opportunity)
- fitLevel: "strong" (75-100), "moderate" (50-74), "weak" (25-49), or "no_bid" (0-24)
- reasoning: 2-3 sentence explanation of the score
- flags: array of strings, each a specific concern or positive factor (e.g. "Requires ISO certification ONWRD doesn't hold", "Directly in ONWRD's core discipline", "Deadline is only 7 days away")

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
    model: "gpt-5.2",
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
  try {
    await runExtractRequirements(tenderId);
  } catch (err) {
    console.error(`[auto-pipeline] requirement extraction failed for tender ${tenderId}:`, err);
    return;
  }
  try {
    await runBidScoring(tenderId);
  } catch (err) {
    console.error(`[auto-pipeline] bid scoring failed for tender ${tenderId}:`, err);
    return;
  }
  try {
    await runGenerateStrategy(tenderId);
  } catch (err) {
    console.error(`[auto-pipeline] strategy generation failed for tender ${tenderId}:`, err);
  }
}

// ── List opportunities ─────────────────────────────────────────────────────
router.get("/opportunities", async (req, res) => {
  try {
    const opportunities = await db
      .select()
      .from(tendersTable)
      .orderBy(desc(tendersTable.recommendationScore), desc(tendersTable.createdAt));
    res.json(opportunities);
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

// ── Update opportunity status ──────────────────────────────────────────────
router.put("/opportunities/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const { status, title, agency, description } = req.body as {
    status?: string;
    title?: string;
    agency?: string;
    description?: string;
  };

  try {
    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (status) updateData.status = status;
    if (title) updateData.title = title;
    if (agency) updateData.agency = agency;
    if (description) updateData.description = description;

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
        model: "gpt-5.2",
        max_completion_tokens: 16000,
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
          model: "gpt-5.2",
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

export default router;
