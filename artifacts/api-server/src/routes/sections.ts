import { Router } from "express";
import { db } from "@workspace/db";
import {
  proposalSectionsTable,
  proposalReviewEventsTable,
  proposalsTable,
  googleExportsTable,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { invokeAI } from "../lib/ai-gateway.js";
import { createGoogleDoc, appendContentWithLogo, clearAndReplaceContent, moveDocToFolder } from "../lib/google-docs.js";
import { googleDriveConfigTable } from "@workspace/db";

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

    // Dirty tracking: if content was updated, mark the parent proposal as having
    // un-synced changes (only meaningful when the proposal has been exported).
    if (content !== undefined) {
      db.update(proposalsTable)
        .set({ dirtySince: new Date() })
        .where(eq(proposalsTable.id, proposalId))
        .catch(() => {});
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

    const { content: raw } = await invokeAI({
      feature: "section_regeneration",
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
      maxTokens: 6000,
      responseFormat: { type: "json_object" },
      proposalId,
      operationKey: "run-critic",
    });
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

// ── Unified export / sync to Google Docs ──────────────────────────────────
//
// POST /proposals/:id/export
//
// Behaviour:
//   - Requires a connected Google OAuth session (googleAccessToken in session)
//   - Loads the configured Drive destination folder (if any) from
//     google_drive_config; the doc is created there.
//   - If the proposal already has a googleFileId (or googleDocUrl from a
//     legacy export) the existing doc is cleared and rewritten — one canonical
//     doc per proposal, no duplicates.
//   - Concurrency guard: returns 409 if syncStatus is already 'syncing'.
//   - Never calls shareWithAnyone — permissions are inherited from the folder.
//
router.post("/proposals/:id/export", async (req, res) => {
  const proposalId = Number(req.params.id);
  if (isNaN(proposalId)) {
    res.status(400).json({ error: "Invalid proposal id" });
    return;
  }

  const accessToken: string | undefined = req.session.googleAccessToken;
  if (!accessToken) {
    res.status(401).json({ error: "Google account not connected. Connect your account in Settings → Google Docs." });
    return;
  }

  // ── 1. Load proposal ──────────────────────────────────────────────────────
  const [proposal] = await db
    .select()
    .from(proposalsTable)
    .where(eq(proposalsTable.id, proposalId));

  if (!proposal) {
    res.status(404).json({ error: "Proposal not found" });
    return;
  }

  // ── 2. Fast-path 409 to avoid a lock-attempt on obviously-busy proposals ─
  if (proposal.syncStatus === "syncing") {
    res.status(409).json({ error: "Export already in progress for this proposal." });
    return;
  }

  // ── 3. Atomic lock: UPDATE ... WHERE sync_status IS DISTINCT FROM 'syncing' ─
  //    Using IS DISTINCT FROM is critical: in Postgres, NULL != 'syncing' is
  //    NULL (not TRUE), so a plain ne() predicate would skip NULL rows and
  //    return 0 rows on the first-ever export of any proposal.
  //    IS DISTINCT FROM treats NULL as a distinct value from 'syncing', so
  //    the WHERE clause matches for both NULL and any non-'syncing' value.
  const [locked] = await db
    .update(proposalsTable)
    .set({ syncStatus: "syncing" })
    .where(and(eq(proposalsTable.id, proposalId), sql`sync_status IS DISTINCT FROM 'syncing'`))
    .returning({ id: proposalsTable.id });

  if (!locked) {
    res.status(409).json({ error: "Export already in progress for this proposal." });
    return;
  }

  try {
    // ── 4. Backward compat: extract fileId from legacy URL ────────────────
    let effectiveFileId = proposal.googleFileId;
    if (!effectiveFileId && proposal.googleDocUrl) {
      const match = proposal.googleDocUrl.match(/\/document\/d\/([^/?#]+)/);
      effectiveFileId = match?.[1] ?? null;
      if (effectiveFileId) {
        await db
          .update(proposalsTable)
          .set({ googleFileId: effectiveFileId })
          .where(eq(proposalsTable.id, proposalId));
      }
    }

    // ── 5. Collect content and Drive config ───────────────────────────────
    const [[driveConfig], sections] = await Promise.all([
      db.select().from(googleDriveConfigTable).limit(1),
      db
        .select()
        .from(proposalSectionsTable)
        .where(eq(proposalSectionsTable.proposalId, proposalId))
        .orderBy(proposalSectionsTable.orderIndex),
    ]);

    const contentToExport =
      sections.length > 0
        ? sections
            .map((s) => `## ${s.title}\n\n${s.content}`)
            .join("\n\n---\n\n")
        : proposal.proposalContent;

    const exportedBy = req.session.googleUserEmail ?? undefined;

    let docUrl: string;
    let documentId: string;
    let isUpdate: boolean;

    if (effectiveFileId) {
      // ── Sync: rewrite existing doc ──────────────────────────────────────
      documentId = effectiveFileId;
      docUrl =
        proposal.googleDocUrl ??
        `https://docs.google.com/document/d/${documentId}/edit`;
      await clearAndReplaceContent(documentId, contentToExport, accessToken);
      isUpdate = true;
    } else {
      // ── Create: new doc — requires a configured destination folder ───────
      if (!driveConfig?.folderId) {
        // Release the lock before returning so retries are not blocked
        await db
          .update(proposalsTable)
          .set({ syncStatus: null })
          .where(eq(proposalsTable.id, proposalId))
          .catch(() => {});
        res.status(400).json({
          error:
            "No Google Drive folder configured. Set a destination folder in Settings → Google Docs before exporting.",
        });
        return;
      }

      const docTitle = `ONWRD Proposal — ${proposal.clientName}`;
      const doc = await createGoogleDoc(docTitle, accessToken);
      documentId = doc.documentId;
      docUrl = `https://docs.google.com/document/d/${documentId}/edit`;

      await moveDocToFolder(
        documentId,
        driveConfig.folderId,
        driveConfig.driveId,
        accessToken,
      );

      await appendContentWithLogo(documentId, contentToExport, accessToken);
      isUpdate = false;
    }

    // ── 6. Record the export ──────────────────────────────────────────────
    await db.insert(googleExportsTable).values({
      proposalId,
      googleDocUrl: docUrl,
      googleFileId: documentId,
      driveFolderId: driveConfig?.folderId ?? null,
      exportedBy: exportedBy ?? null,
    });

    const now = new Date();
    await db
      .update(proposalsTable)
      .set({
        googleDocUrl: docUrl,
        googleFileId: documentId,
        status: isUpdate ? proposal.status : "exported_to_drive",
        syncStatus: "synced",
        lastSyncedAt: now,
        dirtySince: null,
        updatedAt: now,
      })
      .where(eq(proposalsTable.id, proposalId));

    res.json({ docUrl, documentId, isUpdate });
  } catch (err) {
    req.log.error({ err }, "Error exporting to Google Docs");
    // Release the lock and record the error state
    await db
      .update(proposalsTable)
      .set({ syncStatus: "error" })
      .where(eq(proposalsTable.id, proposalId))
      .catch(() => {});
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

      const { content: raw } = await invokeAI({
        feature: "section_regeneration",
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
        maxTokens:      12000,
        responseFormat: { type: "json_object" },
        proposalId,
        operationKey:   "ai-improve-sections",
      });
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
