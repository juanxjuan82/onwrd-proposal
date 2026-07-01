import { Router } from "express";
import multer from "multer";
import mammoth from "mammoth";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { db } from "@workspace/db";
import { knowledgeDocumentsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

const router = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ── List knowledge documents ───────────────────────────────────────────────
router.get("/knowledge", async (req, res) => {
  try {
    const docs = await db
      .select()
      .from(knowledgeDocumentsTable)
      .orderBy(desc(knowledgeDocumentsTable.createdAt));
    res.json(docs);
  } catch (err) {
    req.log.error({ err }, "Error listing knowledge docs");
    res.status(500).json({ error: "Failed to list knowledge documents" });
  }
});

// ── Create knowledge document ──────────────────────────────────────────────
router.post("/knowledge", async (req, res) => {
  const { title, content, docType, tags } = req.body as {
    title: string;
    content: string;
    docType?: string;
    tags?: string[];
  };

  if (!title || !content) {
    res.status(400).json({ error: "title and content are required" });
    return;
  }

  try {
    const [doc] = await db
      .insert(knowledgeDocumentsTable)
      .values({
        title,
        content,
        docType: docType ?? "capability",
        isApproved: false,
        tags: JSON.stringify(tags ?? []),
      })
      .returning();
    res.status(201).json(doc);
  } catch (err) {
    req.log.error({ err }, "Error creating knowledge doc");
    res.status(500).json({ error: "Failed to create knowledge document" });
  }
});

// ── Import knowledge from file ─────────────────────────────────────────────
router.post("/knowledge/import-file", upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }

  const { mimetype, originalname, buffer } = req.file;
  const name = originalname.toLowerCase();
  const title = (req.body.title as string | undefined) || originalname.replace(/\.[^.]+$/, "");
  const docType = (req.body.docType as string | undefined) ?? "capability";

  try {
    let extractedText = "";

    if (
      mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      name.endsWith(".docx")
    ) {
      const result = await mammoth.extractRawText({ buffer });
      extractedText = result.value;
    } else if (mimetype === "application/pdf" || name.endsWith(".pdf")) {
      const result = await pdfParse(buffer);
      extractedText = result.text;
    } else if (mimetype === "text/plain" || name.endsWith(".txt")) {
      extractedText = buffer.toString("utf-8");
    } else {
      res.status(400).json({ error: "Unsupported file type. Upload PDF, DOCX, or TXT." });
      return;
    }

    if (!extractedText.trim()) {
      res.status(400).json({ error: "Could not extract text from the file." });
      return;
    }

    const [doc] = await db
      .insert(knowledgeDocumentsTable)
      .values({
        title,
        content: extractedText.trim(),
        docType,
        isApproved: false,
        tags: "[]",
      })
      .returning();

    res.status(201).json(doc);
  } catch (err) {
    req.log.error({ err }, "Error importing knowledge file");
    res.status(500).json({ error: "Failed to import file" });
  }
});

// ── Get a knowledge document ───────────────────────────────────────────────
router.get("/knowledge/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  try {
    const [doc] = await db
      .select()
      .from(knowledgeDocumentsTable)
      .where(eq(knowledgeDocumentsTable.id, id));

    if (!doc) {
      res.status(404).json({ error: "Knowledge document not found" });
      return;
    }
    res.json(doc);
  } catch (err) {
    req.log.error({ err }, "Error fetching knowledge doc");
    res.status(500).json({ error: "Failed to fetch knowledge document" });
  }
});

// ── Update a knowledge document ────────────────────────────────────────────
router.put("/knowledge/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const { title, content, docType, tags } = req.body as {
    title?: string;
    content?: string;
    docType?: string;
    tags?: string[];
  };

  try {
    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (title !== undefined) updateData.title = title;
    if (content !== undefined) updateData.content = content;
    if (docType !== undefined) updateData.docType = docType;
    if (tags !== undefined) updateData.tags = JSON.stringify(tags);

    const [updated] = await db
      .update(knowledgeDocumentsTable)
      .set(updateData)
      .where(eq(knowledgeDocumentsTable.id, id))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Knowledge document not found" });
      return;
    }
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Error updating knowledge doc");
    res.status(500).json({ error: "Failed to update knowledge document" });
  }
});

// ── Approve for reuse ──────────────────────────────────────────────────────
router.post("/knowledge/:id/approve-for-reuse", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  try {
    const [updated] = await db
      .update(knowledgeDocumentsTable)
      .set({ isApproved: true, updatedAt: new Date() })
      .where(eq(knowledgeDocumentsTable.id, id))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Knowledge document not found" });
      return;
    }
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Error approving knowledge doc");
    res.status(500).json({ error: "Failed to approve knowledge document" });
  }
});

// ── Delete a knowledge document ────────────────────────────────────────────
router.delete("/knowledge/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  try {
    const [deleted] = await db
      .delete(knowledgeDocumentsTable)
      .where(eq(knowledgeDocumentsTable.id, id))
      .returning();

    if (!deleted) {
      res.status(404).json({ error: "Knowledge document not found" });
      return;
    }
    res.status(204).end();
  } catch (err) {
    req.log.error({ err }, "Error deleting knowledge doc");
    res.status(500).json({ error: "Failed to delete knowledge document" });
  }
});

export default router;
