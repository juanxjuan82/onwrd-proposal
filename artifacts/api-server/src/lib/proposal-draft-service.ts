/**
 * Shared proposal-draft service.
 *
 * Centralises the AI prompt, section-definition list, brief/strategy
 * assembly helpers and the atomic persist transaction so that
 * generate-proposal (compatibility) and run-full-generation (orchestrated)
 * routes share exactly one implementation.
 */

import { db } from "@workspace/db";
import {
  proposalSectionsTable,
  proposalGenerationRunsTable,
  proposalsTable,
  tendersTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { invokeAI } from "./ai-gateway.js";
import { assembleProposalFromSections } from "@workspace/proposal-content";
import { ONWRD_CASE_STUDIES } from "./onwrd-case-studies.js";

// ── Section catalogue ─────────────────────────────────────────────────────────

export const SECTION_DEFINITIONS = [
  { key: "executive_summary",   title: "Executive Summary",                         order: 0  },
  { key: "client_context",      title: "Client Context and Problem Definition",      order: 1  },
  { key: "goals_kpis",          title: "Goals, KPIs and Success Criteria",           order: 2  },
  { key: "strategic_approach",  title: "Recommended Strategic Approach",             order: 3  },
  { key: "scope_of_work",       title: "Detailed Scope of Work",                     order: 4  },
  { key: "deliverables",        title: "Deliverables Register",                      order: 5  },
  { key: "timeline",            title: "Timeline, Milestones and Dependencies",      order: 6  },
  { key: "team_structure",      title: "Team Structure and Ways of Working",         order: 7  },
  { key: "investment",          title: "Investment and Commercial Terms",            order: 8  },
  { key: "assumptions_risks",   title: "Assumptions, Exclusions and Risks",          order: 9  },
  { key: "governance",          title: "Governance, Approval and Change Control",    order: 10 },
  { key: "why_onwrd",           title: "Why ONWRD",                                 order: 11 },
  { key: "case_studies",        title: "Case Studies and Credentials",               order: 12 },
  { key: "legal_terms",         title: "Legal and Operational Terms",                order: 13 },
  { key: "next_steps",          title: "Next Steps and Acceptance",                  order: 14 },
] as const;

// ── Brief & strategy helpers ──────────────────────────────────────────────────

export function buildBriefText(
  tender: {
    title: string;
    agency: string;
    category: string;
    deadline?: Date | string | null;
    valueAmount?: string | null;
    contactInfo?: string | null;
    sourceUrl?: string | null;
    description: string;
  },
  requirements: Array<{
    category: string;
    isMandatory: boolean | null;
    requirementText: string;
  }>,
): string {
  return `TENDER OPPORTUNITY — ${tender.title}

Issuing Agency: ${tender.agency}
Category: ${tender.category}
${tender.deadline ? `Submission Deadline: ${new Date(tender.deadline).toDateString()}` : ""}
${tender.valueAmount ? `Estimated Value: ${tender.valueAmount}` : ""}
${tender.contactInfo ? `Contact: ${tender.contactInfo}` : ""}
${tender.sourceUrl ? `Source: ${tender.sourceUrl}` : ""}

SCOPE / DESCRIPTION:
${tender.description}
${requirements.length > 0 ? `\nEXTRACTED REQUIREMENTS:\n${requirements.map((r, i) => `${i + 1}. [${r.category}${r.isMandatory ? ", MANDATORY" : ""}] ${r.requirementText}`).join("\n")}` : ""}`;
}

export function buildStrategyContext(strategy: {
  positioning: string;
  winThemes?: string | null;
  recommendedCaseStudies?: string | null;
  messagingGuidance?: string | null;
  risks?: string | null;
} | null | undefined): string {
  if (!strategy) return "";
  return `\nPROPOSAL STRATEGY BRIEF:\nPositioning: ${strategy.positioning}\nWin Themes: ${JSON.parse(strategy.winThemes ?? "[]").join(", ")}\nRecommended Case Studies: ${JSON.parse(strategy.recommendedCaseStudies ?? "[]").join(", ")}\nMessaging Guidance: ${strategy.messagingGuidance}\nRisks to Address: ${JSON.parse(strategy.risks ?? "[]").join(", ")}`;
}

// ── Shared AI system prompt ───────────────────────────────────────────────────

const DRAFT_SYSTEM_PROMPT = `You are a senior proposal writer at ONWRD, a full-service marketing and strategy agency in the Bahamas. Write a complete, professional proposal responding to a public tender opportunity.

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
- content: the section BODY ONLY — do NOT start with the section title as a heading. Internal subheadings should use ### (level 3 only). Use markdown bold with ** and bullets with -.`;

// ── Core service ──────────────────────────────────────────────────────────────

export interface DraftInput {
  tenderId: number;
  proposalId: number;
  /** Assembled from tender row + extracted requirements. */
  briefText: string;
  /** Assembled from the latest strategy row; empty string if none. */
  strategyContext: string;
}

export interface DraftResult {
  hasBlockedSections: boolean;
  /** 'ready_for_review' | 'needs_onwrd_input' */
  finalStatus: string;
}

/**
 * Generates a proposal draft via AI and persists it atomically.
 *
 * The AI call happens OUTSIDE the database transaction. Only after valid
 * AI output is available does a single transaction:
 *   1. Record the generation run.
 *   2. Replace section rows (atomically — prior content preserved on failure).
 *   3. Read all ordered sections.
 *   4. Assemble the proposal_content snapshot via assembleProposalFromSections.
 *   5. Update the proposal row (proposalContent + status).
 *   6. Update the tender row (status).
 *
 * If the transaction fails, all changes roll back — prior section content
 * and the snapshot are preserved.
 *
 * Does NOT set generation_status; the orchestrator manages that column.
 */
export async function generateProposalDraftAndPersist({
  tenderId,
  proposalId,
  briefText,
  strategyContext,
}: DraftInput): Promise<DraftResult> {
  type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

  // ── 1. AI call — outside any transaction ────────────────────────────────
  const genAiResult = await invokeAI({
    feature:        "proposal_generation",
    messages: [
      { role: "system", content: DRAFT_SYSTEM_PROMPT },
      {
        role:    "user",
        content: `Write all ${SECTION_DEFINITIONS.length} sections of a proposal for this tender:\n\n${briefText}\n${strategyContext}\n\nSections to write (return all ${SECTION_DEFINITIONS.length}):\n${SECTION_DEFINITIONS.map((s) => `- ${s.key}: ${s.title}`).join("\n")}`,
      },
    ],
    maxTokens:      16000,
    responseFormat: { type: "json_object" },
    proposalId,
  });

  // ── 2. Parse output ─────────────────────────────────────────────────────
  const genData = JSON.parse(genAiResult.content) as {
    sections?: { key: string; content: string }[];
  };
  const aiSections = genData.sections ?? [];

  // ── 3. Map section content after successful parse ────────────────────────
  let hasBlockedSections = false;
  const sectionValues = SECTION_DEFINITIONS.map((sectionDef) => {
    const generated  = aiSections.find((s) => s.key === sectionDef.key);
    const content    = generated?.content ?? `[NEEDS ONWRD INPUT: ${sectionDef.title} section not generated]`;
    const hasBlocker = content.includes("[NEEDS ONWRD INPUT");
    if (hasBlocker) hasBlockedSections = true;
    return {
      sectionKey:  sectionDef.key,
      title:       sectionDef.title,
      content,
      status:      (hasBlocker ? "blocked_missing_input" : "drafted") as string,
      orderIndex:  sectionDef.order,
    };
  });

  const finalStatus = hasBlockedSections ? "needs_onwrd_input" : "ready_for_review";

  // ── 4. ONE atomic transaction: replace sections + update snapshot ────────
  await db.transaction(async (tx: DbTx) => {
    // a. Record generation run
    const [genRun] = await tx
      .insert(proposalGenerationRunsTable)
      .values({
        proposalId,
        model:                 genAiResult.model,
        promptVersion:         "2.0",
        retrievedKnowledgeIds: "[]",
        status:                "completed",
      })
      .returning();

    // b. Replace sections — delete stale rows first, then insert AI content.
    //    This happens only AFTER AI output is validated, so prior content is
    //    preserved if the AI call or JSON parse above throws.
    await tx.execute(sql`DELETE FROM proposal_sections WHERE proposal_id = ${proposalId}`);
    await tx.insert(proposalSectionsTable).values(
      sectionValues.map((sv) => ({
        proposalId,
        sectionKey:      sv.sectionKey,
        title:           sv.title,
        content:         sv.content,
        status:          sv.status,
        orderIndex:      sv.orderIndex,
        generationRunId: genRun.id,
      })),
    );

    // c. Read all sections in order for snapshot assembly
    const allSections = await tx
      .select()
      .from(proposalSectionsTable)
      .where(eq(proposalSectionsTable.proposalId, proposalId))
      .orderBy(proposalSectionsTable.orderIndex);

    // d. Assemble snapshot + update proposal
    const assembledContent = assembleProposalFromSections(allSections);
    await tx
      .update(proposalsTable)
      .set({ proposalContent: assembledContent, status: finalStatus, updatedAt: new Date() })
      .where(eq(proposalsTable.id, proposalId));

    // e. Update tender status
    await tx
      .update(tendersTable)
      .set({ status: finalStatus, updatedAt: new Date() })
      .where(eq(tendersTable.id, tenderId));
  });

  return { hasBlockedSections, finalStatus };
}
