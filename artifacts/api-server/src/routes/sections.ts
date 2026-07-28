import { Router } from "express";
import { googleDocCanonicalPayload } from "../lib/proposal-predicates.js";
import { db } from "@workspace/db";
import {
  proposalSectionsTable,
  proposalReviewEventsTable,
  proposalsTable,
  googleExportsTable,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { invokeAI } from "../lib/ai-gateway.js";
import { appendContentWithLogo, createGoogleDocInFolder, resetIncompleteDoc } from "../lib/google-docs.js";
import { getValidGoogleAccessToken, GoogleAuthError } from "../lib/google-auth.js";
import { googleDriveConfigTable } from "@workspace/db";
import { assembleProposalFromSections } from "@workspace/proposal-content";

const router = Router();

// ── Shared type for Drizzle transactions ──────────────────────────────────
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ── Immutability guard helper ─────────────────────────────────────────────
// Returns a 409-ready payload when the proposal has a canonical Google Doc,
// (googleDocCanonicalPayload imported from ../lib/proposal-predicates.js)

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

  // ── Immutability guard ─────────────────────────────────────────────────
  const [proposal] = await db
    .select({
      syncStatus:   proposalsTable.syncStatus,
      googleFileId: proposalsTable.googleFileId,
      googleDocUrl: proposalsTable.googleDocUrl,
    })
    .from(proposalsTable)
    .where(eq(proposalsTable.id, proposalId));

  if (!proposal) {
    res.status(404).json({ error: "Proposal not found" });
    return;
  }

  const blocked = googleDocCanonicalPayload(proposal);
  if (blocked) {
    res.status(409).json(blocked);
    return;
  }

  try {
    const updated = await db.transaction(async (tx: DbTx) => {
      const updateData: Record<string, unknown> = { updatedAt: new Date() };
      if (content !== undefined) updateData.content = content;
      if (status !== undefined) updateData.status = status;
      if (status === "approved") updateData.approvedAt = new Date();

      const [updated] = await tx
        .update(proposalSectionsTable)
        .set(updateData)
        .where(
          and(
            eq(proposalSectionsTable.id, sectionId),
            eq(proposalSectionsTable.proposalId, proposalId)
          )
        )
        .returning();

      if (!updated) return null;

      if (status === "approved") {
        await tx.insert(proposalReviewEventsTable).values({
          proposalId,
          sectionId,
          eventType: "section_approved",
          notes: null,
        });
      }

      // Rebuild proposalContent snapshot atomically when content changes
      if (content !== undefined) {
        const allSections = await tx
          .select()
          .from(proposalSectionsTable)
          .where(eq(proposalSectionsTable.proposalId, proposalId))
          .orderBy(proposalSectionsTable.orderIndex);

        const assembled = assembleProposalFromSections(allSections);
        await tx
          .update(proposalsTable)
          .set({ proposalContent: assembled, dirtySince: new Date(), updatedAt: new Date() })
          .where(eq(proposalsTable.id, proposalId));
      }

      return updated;
    });

    if (!updated) {
      res.status(404).json({ error: "Section not found" });
      return;
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

  // run-critic only writes criticFindings annotations, not proposal content,
  // so it is intentionally NOT blocked by the Google Doc immutability guard.

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

  // ── Immutability guard ─────────────────────────────────────────────────
  const blocked = googleDocCanonicalPayload(proposal);
  if (blocked) {
    res.status(409).json(blocked);
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
const STALE_LOCK_MS = 5 * 60 * 1000; // 5 minutes

router.post("/proposals/:id/export", async (req, res) => {
  const proposalId = Number(req.params.id);
  if (isNaN(proposalId)) {
    res.status(400).json({ error: "Invalid proposal id" });
    return;
  }

  // ── 1. Load proposal first ────────────────────────────────────────────────
  const [proposal] = await db
    .select()
    .from(proposalsTable)
    .where(eq(proposalsTable.id, proposalId));

  if (!proposal) {
    res.status(404).json({ error: "Proposal not found" });
    return;
  }

  // ── 2. Early return for completed / legacy documents — NO auth required ───
  //    handoff_complete = successfully shared; Google Doc is now canonical.
  //    Legacy linked = has a fileId but was never in our new state machine
  //    (syncStatus is not pending_first_write and not handoff_in_progress).
  const isHandoffComplete = proposal.syncStatus === "handoff_complete";
  const isLegacyLinked =
    !!proposal.googleFileId &&
    proposal.syncStatus !== "pending_first_write" &&
    proposal.syncStatus !== "handoff_in_progress" &&
    !isHandoffComplete;

  if (isHandoffComplete || isLegacyLinked) {
    const docUrl =
      proposal.googleDocUrl ??
      `https://docs.google.com/document/d/${proposal.googleFileId}/edit`;
    res.json({ docUrl, alreadyComplete: true });
    return;
  }

  // ── 2a. Draft readiness — evaluated BEFORE auth or any Google API call ────
  // Avoids triggering OAuth flows for proposals that aren't ready to export.
  const DRAFTING_PLACEHOLDER = /generating proposal sections/i;
  const hasMeaningfulContent = (text: string | null | undefined): boolean =>
    !!(text?.trim()) && !DRAFTING_PLACEHOLDER.test(text.trim());

  const allSections = await db
    .select()
    .from(proposalSectionsTable)
    .where(eq(proposalSectionsTable.proposalId, proposalId))
    .orderBy(proposalSectionsTable.orderIndex);

  // Only sections with meaningful content are exported — empty shells are omitted.
  const meaningfulSections = allSections.filter((s) => hasMeaningfulContent(s.content));

  let exportContent: string;
  if (meaningfulSections.length > 0) {
    exportContent = assembleProposalFromSections(meaningfulSections);
  } else if (hasMeaningfulContent(proposal.proposalContent)) {
    exportContent = proposal.proposalContent!;
  } else {
    res.status(422).json({
      error: "Proposal draft is not ready to share. Wait for generation to complete.",
      code:  "draft_not_ready",
    });
    return;
  }

  // ── 3. Auth check — only needed for new / retry handoffs ─────────────────
  let accessToken: string;
  try {
    accessToken = await getValidGoogleAccessToken(req.session);
    await new Promise<void>((resolve) => req.session.save(() => resolve()));
  } catch (err) {
    if (err instanceof GoogleAuthError) {
      res.status(401).json({
        error: "Google account not connected. Connect your account in Settings → Google Docs.",
        reason: err.reason,
      });
      return;
    }
    throw err;
  }

  // ── 4. Stale-lock recovery ────────────────────────────────────────────────
  //    handoff_in_progress is transient; a server restart can leave it stuck.
  //    After STALE_LOCK_MS, recover based on whether a doc ID was recorded.
  if (proposal.syncStatus === "handoff_in_progress") {
    const startedAt = proposal.handoffStartedAt?.getTime() ?? 0;
    if (Date.now() - startedAt < STALE_LOCK_MS) {
      res.status(409).json({ error: "Handoff already in progress for this proposal. Try again in a moment." });
      return;
    }
    // Stale: recover
    const recoverTo = proposal.googleFileId ? "pending_first_write" : null;
    await db
      .update(proposalsTable)
      .set({ syncStatus: recoverTo, handoffStartedAt: null })
      .where(and(eq(proposalsTable.id, proposalId), sql`sync_status = 'handoff_in_progress'`));
    proposal.syncStatus = recoverTo;
  }

  // ── 5. Acquire atomic lock ────────────────────────────────────────────────
  //    Fresh: WHERE sync_status IS NULL
  //    Retry: WHERE sync_status = 'pending_first_write'
  //    Any other concurrent request gets 0 rows → 409.
  const isRetry = proposal.syncStatus === "pending_first_write";
  const lockCondition = isRetry
    ? sql`sync_status = 'pending_first_write'`
    : sql`sync_status IS NULL`;

  const [locked] = await db
    .update(proposalsTable)
    .set({ syncStatus: "handoff_in_progress", handoffStartedAt: new Date() })
    .where(and(eq(proposalsTable.id, proposalId), lockCondition))
    .returning({ id: proposalsTable.id });

  if (!locked) {
    res.status(409).json({ error: "Handoff already in progress for this proposal. Try again in a moment." });
    return;
  }

  try {
    // ── 6. Require configured folder ─────────────────────────────────────
    const [driveConfig] = await db.select().from(googleDriveConfigTable).limit(1);

    if (!driveConfig?.folderId) {
      await db
        .update(proposalsTable)
        .set({ syncStatus: null, handoffStartedAt: null })
        .where(eq(proposalsTable.id, proposalId))
        .catch(() => {});
      res.status(400).json({
        error: "No Google Drive folder configured. Set a destination folder in Settings → Google Docs before exporting.",
      });
      return;
    }

    // exportContent was computed in step 2a before auth.
    const content = exportContent;

    const exportedBy = req.session.googleUserEmail ?? null;

    let documentId: string;
    let docUrl: string;

    if (isRetry) {
      // ── Retry: reuse same doc, reset partial content, write clean ────────
      // GUARD: resetIncompleteDoc is only called here, exclusively for
      // proposals that were in pending_first_write.
      documentId = proposal.googleFileId!;
      docUrl =
        proposal.googleDocUrl ??
        `https://docs.google.com/document/d/${documentId}/edit`;
      await resetIncompleteDoc(documentId, content, accessToken);
    } else {
      // ── First handoff: create doc directly in configured folder ───────────
      const docTitle = `ONWRD Proposal — ${proposal.clientName}`;

      let newDoc: { id: string; webViewLink?: string };
      try {
        newDoc = await createGoogleDocInFolder(docTitle, driveConfig.folderId, accessToken);
      } catch (createErr) {
        // Creation failed before an ID was recorded — release lock cleanly
        await db
          .update(proposalsTable)
          .set({ syncStatus: null, handoffStartedAt: null })
          .where(eq(proposalsTable.id, proposalId))
          .catch(() => {});
        throw createErr;
      }

      documentId = newDoc.id;
      docUrl = newDoc.webViewLink ?? `https://docs.google.com/document/d/${documentId}/edit`;

      // Persist the document ID BEFORE writing content so a content-write
      // failure is recoverable (pending_first_write retry reuses this ID).
      await db
        .update(proposalsTable)
        .set({ googleFileId: documentId, googleDocUrl: docUrl })
        .where(eq(proposalsTable.id, proposalId));

      try {
        await appendContentWithLogo(documentId, content, accessToken);
      } catch (contentErr) {
        // ID is recorded; mark as pending_first_write so next request retries
        await db
          .update(proposalsTable)
          .set({ syncStatus: "pending_first_write", handoffStartedAt: null })
          .where(eq(proposalsTable.id, proposalId))
          .catch(() => {});
        throw contentErr;
      }
    }

    // ── 7. Completion writes — single transaction ─────────────────────────
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(proposalsTable)
        .set({
          googleDocUrl: docUrl,
          googleFileId: documentId,
          syncStatus: "handoff_complete",
          status: "exported_to_drive",
          lastSyncedAt: now,
          handoffStartedAt: null,
          updatedAt: now,
        })
        .where(eq(proposalsTable.id, proposalId));

      await tx.insert(googleExportsTable).values({
        proposalId,
        googleDocUrl: docUrl,
        googleFileId: documentId,
        driveFolderId: driveConfig.folderId,
        exportedBy,
      });
    });

    res.json({ docUrl, documentId, alreadyComplete: false });
  } catch (err) {
    req.log.error({ err }, "Error during proposal handoff to Google Docs");

    // If still stuck in handoff_in_progress (not already set to pending_first_write
    // by the content-write failure handler above), recover based on whether
    // a document ID has been recorded.
    try {
      const [current] = await db
        .select({ syncStatus: proposalsTable.syncStatus, googleFileId: proposalsTable.googleFileId })
        .from(proposalsTable)
        .where(eq(proposalsTable.id, proposalId));

      if (current?.syncStatus === "handoff_in_progress") {
        await db
          .update(proposalsTable)
          .set({
            syncStatus: current.googleFileId ? "pending_first_write" : null,
            handoffStartedAt: null,
          })
          .where(eq(proposalsTable.id, proposalId));
      }
    } catch {
      // best-effort
    }

    res.status(500).json({ error: "Failed to export to Google Docs. Try again." });
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

  // ── Immutability guard ─────────────────────────────────────────────────
  const blocked = googleDocCanonicalPayload(proposal);
  if (blocked) {
    res.status(409).json(blocked);
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

      // Atomic: write all improved sections AND rebuild snapshot in one transaction.
      // If anything fails, no section writes are committed and the prior
      // snapshot is preserved.
      await db.transaction(async (tx: DbTx) => {
        for (const improvement of improvements) {
          const section = sectionsToImprove.find((s) => s.sectionKey === improvement.sectionKey);
          if (!section || !improvement.content) continue;

          const hasBlocker = improvement.content.includes("[NEEDS ONWRD INPUT");
          await tx
            .update(proposalSectionsTable)
            .set({
              content:        improvement.content,
              status:         hasBlocker ? "blocked_missing_input" : "drafted",
              criticFindings: null,
              updatedAt:      new Date(),
            })
            .where(and(
              eq(proposalSectionsTable.id, section.id),
              eq(proposalSectionsTable.proposalId, proposalId),
            ));
        }

        // Rebuild snapshot from all sections (including unchanged ones)
        const allSections = await tx
          .select()
          .from(proposalSectionsTable)
          .where(eq(proposalSectionsTable.proposalId, proposalId))
          .orderBy(proposalSectionsTable.orderIndex);

        const assembled = assembleProposalFromSections(allSections);
        await tx
          .update(proposalsTable)
          .set({ proposalContent: assembled, dirtySince: new Date(), updatedAt: new Date() })
          .where(eq(proposalsTable.id, proposalId));
      });
    } catch (err) {
      console.error("[ai-improve-sections] failed:", err);
    }
  })();
});

export default router;
