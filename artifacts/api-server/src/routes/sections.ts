import { Router } from "express";
import { db } from "@workspace/db";
import {
  proposalSectionsTable,
  proposalReviewEventsTable,
  proposalsTable,
  googleExportsTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";
import { createGoogleDoc, appendContentWithLogo, shareWithAnyone } from "../lib/google-docs.js";

const router = Router();

// ── List sections for a proposal ──────────────────────────────────────────
router.get("/proposals/:id/sections", async (req, res) => {
  const proposalId = Number(req.params.id);
  if (isNaN(proposalId)) {
    res.status(400).json({ error: "Invalid proposal id" });
    return;
  }

  try {
    const sections = await db
      .select()
      .from(proposalSectionsTable)
      .where(eq(proposalSectionsTable.proposalId, proposalId))
      .orderBy(proposalSectionsTable.orderIndex);
    res.json(sections);
  } catch (err) {
    req.log.error({ err }, "Error listing sections");
    res.status(500).json({ error: "Failed to list sections" });
  }
});

// ── Update a single section ────────────────────────────────────────────────
router.put("/proposals/:id/sections/:sectionId", async (req, res) => {
  const proposalId = Number(req.params.id);
  const sectionId = Number(req.params.sectionId);
  if (isNaN(proposalId) || isNaN(sectionId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const { content, status } = req.body as { content?: string; status?: string };

  try {
    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (content !== undefined) updateData.content = content;
    if (status !== undefined) updateData.status = status;

    if (status === "approved") {
      updateData.approvedAt = new Date();
    }

    const [updated] = await db
      .update(proposalSectionsTable)
      .set(updateData)
      .where(
        and(
          eq(proposalSectionsTable.id, sectionId),
          eq(proposalSectionsTable.proposalId, proposalId)
        )
      )
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Section not found" });
      return;
    }

    if (status === "approved") {
      await db.insert(proposalReviewEventsTable).values({
        proposalId,
        sectionId,
        eventType: "section_approved",
        notes: null,
      });
    }

    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Error updating section");
    res.status(500).json({ error: "Failed to update section" });
  }
});

// ── Run critic pass ────────────────────────────────────────────────────────
router.post("/proposals/:id/run-critic", async (req, res) => {
  const proposalId = Number(req.params.id);
  if (isNaN(proposalId)) {
    res.status(400).json({ error: "Invalid proposal id" });
    return;
  }

  const [proposal] = await db
    .select()
    .from(proposalsTable)
    .where(eq(proposalsTable.id, proposalId));

  if (!proposal) {
    res.status(404).json({ error: "Proposal not found" });
    return;
  }

  const sections = await db
    .select()
    .from(proposalSectionsTable)
    .where(eq(proposalSectionsTable.proposalId, proposalId))
    .orderBy(proposalSectionsTable.orderIndex);

  if (sections.length === 0) {
    res.status(400).json({ error: "This proposal has no sections. Generate sections first." });
    return;
  }

  try {
    const sectionSummary = sections
      .map((s) => `=== ${s.title} (${s.sectionKey}) ===\n${s.content || "[empty]"}`)
      .join("\n\n");

    const completion = await openai.chat.completions.create({
      model: "gpt-5.2",
      max_completion_tokens: 6000,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are a senior proposal reviewer at ONWRD. Your job is to audit proposal sections for quality issues. For each section, identify:
1. Unsupported claims about ONWRD (credentials, metrics, outcomes not backed by real case studies)
2. Vague or generic language that doesn't address the specific tender
3. Missing compliance items (requirements from the brief that aren't addressed)
4. [NEEDS ONWRD INPUT] placeholders that haven't been filled in
5. Contradictions or logical gaps

Return JSON with a "sections" array. Each element:
- sectionKey: the key of the section
- issues: array of strings (specific issues found, or empty if none)
- severity: "clean", "minor", or "major"`,
        },
        {
          role: "user",
          content: `Review this proposal for tender: ${proposal.clientName} — ${proposal.industry}\n\n${sectionSummary}`,
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    const data = JSON.parse(raw);
    const criticResults: { sectionKey: string; issues: string[]; severity: string }[] = data.sections ?? [];

    for (const result of criticResults) {
      const section = sections.find((s) => s.sectionKey === result.sectionKey);
      if (!section) continue;

      const findings = result.issues.length > 0 ? result.issues.join("\n- ") : null;
      const newStatus =
        result.severity === "major"
          ? "needs_review"
          : section.status === "approved"
          ? "approved"
          : section.status;

      await db
        .update(proposalSectionsTable)
        .set({
          criticFindings: findings ? `- ${findings}` : null,
          status: newStatus,
          updatedAt: new Date(),
        })
        .where(eq(proposalSectionsTable.id, section.id));
    }

    const updatedSections = await db
      .select()
      .from(proposalSectionsTable)
      .where(eq(proposalSectionsTable.proposalId, proposalId))
      .orderBy(proposalSectionsTable.orderIndex);

    res.json({ sections: updatedSections, summary: criticResults });
  } catch (err) {
    req.log.error({ err }, "Error running critic");
    res.status(500).json({ error: "Failed to run critic pass" });
  }
});

// ── Approve for export (quality gate) ────────────────────────────────────
router.post("/proposals/:id/approve-for-export", async (req, res) => {
  const proposalId = Number(req.params.id);
  if (isNaN(proposalId)) {
    res.status(400).json({ error: "Invalid proposal id" });
    return;
  }

  const { overrideReason } = req.body as { overrideReason?: string };

  const [proposal] = await db
    .select()
    .from(proposalsTable)
    .where(eq(proposalsTable.id, proposalId));

  if (!proposal) {
    res.status(404).json({ error: "Proposal not found" });
    return;
  }

  const sections = await db
    .select()
    .from(proposalSectionsTable)
    .where(eq(proposalSectionsTable.proposalId, proposalId));

  const blockedSections = sections.filter((s) => s.status === "blocked_missing_input");
  const majorIssues = sections.filter((s) => s.status === "needs_review");

  const blockers: string[] = [];
  if (blockedSections.length > 0 && !overrideReason) {
    blockers.push(`${blockedSections.length} section(s) have missing ONWRD input: ${blockedSections.map((s) => s.title).join(", ")}`);
  }
  if (majorIssues.length > 0 && !overrideReason) {
    blockers.push(`${majorIssues.length} section(s) have major critic issues: ${majorIssues.map((s) => s.title).join(", ")}`);
  }

  if (blockers.length > 0) {
    res.status(422).json({
      error: "Export blocked by quality gate",
      blockers,
      hint: "Resolve blockers or provide an overrideReason to bypass.",
    });
    return;
  }

  await db
    .update(proposalsTable)
    .set({ status: "approved_for_export", updatedAt: new Date() })
    .where(eq(proposalsTable.id, proposalId));

  await db.insert(proposalReviewEventsTable).values({
    proposalId,
    sectionId: null,
    eventType: "proposal_approved",
    notes: "Approved for export",
    overrideReason: overrideReason ?? null,
  });

  const updatedProposal = await db
    .select()
    .from(proposalsTable)
    .where(eq(proposalsTable.id, proposalId));

  res.json(updatedProposal[0]);
});

// ── Export to Google Docs (enhanced) ──────────────────────────────────────
router.post("/proposals/:id/export-to-google-docs", async (req, res) => {
  const proposalId = Number(req.params.id);
  if (isNaN(proposalId)) {
    res.status(400).json({ error: "Invalid proposal id" });
    return;
  }

  const [proposal] = await db
    .select()
    .from(proposalsTable)
    .where(eq(proposalsTable.id, proposalId));

  if (!proposal) {
    res.status(404).json({ error: "Proposal not found" });
    return;
  }

  const accessToken: string | undefined = req.session.googleAccessToken;

  try {
    const sections = await db
      .select()
      .from(proposalSectionsTable)
      .where(eq(proposalSectionsTable.proposalId, proposalId))
      .orderBy(proposalSectionsTable.orderIndex);

    const contentToExport = sections.length > 0
      ? sections.map((s) => `## ${s.title}\n\n${s.content}`).join("\n\n---\n\n")
      : proposal.proposalContent;

    const docTitle = `ONWRD Proposal — ${proposal.clientName}`;
    const doc = await createGoogleDoc(docTitle, accessToken);
    await appendContentWithLogo(doc.documentId, contentToExport, accessToken);
    await shareWithAnyone(doc.documentId, accessToken);

    const docUrl = `https://docs.google.com/document/d/${doc.documentId}/edit`;

    await db.insert(googleExportsTable).values({
      proposalId,
      googleDocUrl: docUrl,
      googleFileId: doc.documentId,
      driveFolderId: null,
    });

    await db
      .update(proposalsTable)
      .set({
        googleDocUrl: docUrl,
        googleFileId: doc.documentId,
        status: "exported_to_drive",
        updatedAt: new Date(),
      })
      .where(eq(proposalsTable.id, proposalId));

    res.json({ docUrl, documentId: doc.documentId });
  } catch (err) {
    req.log.error({ err }, "Error exporting to Google Docs");
    res.status(500).json({ error: "Failed to export to Google Docs" });
  }
});

// ── AI improve sections with critic findings ───────────────────────────────
router.post("/proposals/:id/ai-improve-sections", async (req, res) => {
  const proposalId = Number(req.params.id);
  if (isNaN(proposalId)) {
    res.status(400).json({ error: "Invalid proposal id" });
    return;
  }

  const [proposal] = await db
    .select()
    .from(proposalsTable)
    .where(eq(proposalsTable.id, proposalId));

  if (!proposal) {
    res.status(404).json({ error: "Proposal not found" });
    return;
  }

  const sections = await db
    .select()
    .from(proposalSectionsTable)
    .where(eq(proposalSectionsTable.proposalId, proposalId))
    .orderBy(proposalSectionsTable.orderIndex);

  const sectionsToImprove = sections.filter(
    (s) => s.criticFindings && (s.status === "needs_review" || s.status === "drafted")
  );

  if (sectionsToImprove.length === 0) {
    res.status(400).json({ error: "No sections with critic findings to improve. Run the critic pass first." });
    return;
  }

  res.json({ message: "Improvement started", count: sectionsToImprove.length });

  (async () => {
    try {
      const sectionPayload = sectionsToImprove
        .map((s) => `=== ${s.title} (${s.sectionKey}) ===\nCRITIC FINDINGS:\n${s.criticFindings}\n\nCURRENT CONTENT:\n${s.content}`)
        .join("\n\n---\n\n");

      const completion = await openai.chat.completions.create({
        model: "gpt-5.2",
        max_completion_tokens: 12000,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `You are a senior proposal editor at ONWRD. You receive proposal sections that have been flagged by a critic with specific issues. Your job is to rewrite each section to address the issues.

Rules:
- Address every critic finding directly
- Keep the same general structure and intent — improve quality, don't replace it
- Do not invent credentials, metrics, or case studies not grounded in the original content
- If a critic finding says to add specific ONWRD information you don't have, insert [NEEDS ONWRD INPUT: description] rather than fabricating it
- Write in plain, direct English — no jargon or filler

Return JSON with an "improvements" array. Each element:
- sectionKey: the section key
- content: the fully rewritten section content (markdown)
- changesSummary: 1-2 sentences describing what you changed and why`,
          },
          {
            role: "user",
            content: `Improve these proposal sections for client: ${proposal.clientName}\n\n${sectionPayload}`,
          },
        ],
      });

      const raw = completion.choices[0]?.message?.content ?? "{}";
      const data = JSON.parse(raw);
      const improvements: { sectionKey: string; content: string; changesSummary: string }[] = data.improvements ?? [];

      for (const improvement of improvements) {
        const section = sectionsToImprove.find((s) => s.sectionKey === improvement.sectionKey);
        if (!section || !improvement.content) continue;

        const hasBlocker = improvement.content.includes("[NEEDS ONWRD INPUT");
        await db
          .update(proposalSectionsTable)
          .set({
            content: improvement.content,
            status: hasBlocker ? "blocked_missing_input" : "drafted",
            criticFindings: null,
            updatedAt: new Date(),
          })
          .where(and(
            eq(proposalSectionsTable.id, section.id),
            eq(proposalSectionsTable.proposalId, proposalId)
          ));
      }
    } catch (err) {
      console.error("[ai-improve-sections] failed:", err);
    }
  })();
});

export default router;
