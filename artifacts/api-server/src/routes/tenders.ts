import { Router } from "express";
import { db } from "@workspace/db";
import { tendersTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { extractTenderMetadata } from "../lib/metadata-extractor.js";
import {
  CreateTenderBody,
  GetTenderParams,
  DeleteTenderParams,
  ImportTendersCsvBody,
  ExtractTenderFromTextBody,
} from "@workspace/api-zod";

const router = Router();

const MARKETING_KEYWORDS = [
  "marketing", "advertising", "branding", "brand", "communications", "comms",
  "public relations", "pr ", "media", "digital", "social media", "social",
  "campaign", "creative", "content", "graphic design", "design", "video",
  "production", "website", "web design", "seo", "promotion", "publicity",
  "outreach", "tourism marketing", "event", "sponsorship", "audio visual",
];

function scoreTender(title: string, description: string, category: string): number {
  const text = `${title} ${description} ${category}`.toLowerCase();
  let score = 0;
  for (const kw of MARKETING_KEYWORDS) {
    if (text.includes(kw)) score += 1;
  }
  return score;
}

/** Parse a CSV string into rows. Supports quoted fields with commas/newlines. */
function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        row.push(cell);
        cell = "";
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && input[i + 1] === "\n") i++;
        row.push(cell);
        if (row.some((c) => c.trim() !== "")) rows.push(row);
        row = [];
        cell = "";
      } else {
        cell += ch;
      }
    }
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    if (row.some((c) => c.trim() !== "")) rows.push(row);
  }
  return rows;
}

// ── List tenders ──────────────────────────────────────────────────────────
router.get("/tenders", async (req, res) => {
  const recommended = req.query.recommended === "true";
  const all = await db
    .select()
    .from(tendersTable)
    .orderBy(desc(tendersTable.recommendationScore), desc(tendersTable.createdAt));
  const filtered = recommended ? all.filter((t) => t.recommendationScore > 0) : all;
  res.json(filtered);
});

// ── Get tender ────────────────────────────────────────────────────────────
router.get("/tenders/:id", async (req, res) => {
  const parsed = GetTenderParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [tender] = await db
    .select()
    .from(tendersTable)
    .where(eq(tendersTable.id, parsed.data.id));
  if (!tender) {
    res.status(404).json({ error: "Tender not found" });
    return;
  }
  res.json(tender);
});

// ── Create tender ─────────────────────────────────────────────────────────
router.post("/tenders", async (req, res) => {
  const parsed = CreateTenderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const data = parsed.data;
  const score = scoreTender(data.title, data.description, data.category ?? "General");
  const [created] = await db
    .insert(tendersTable)
    .values({
      title: data.title,
      agency: data.agency,
      description: data.description,
      category: data.category ?? "General",
      deadline: data.deadline ?? null,
      valueAmount: data.valueAmount ?? null,
      sourceUrl: data.sourceUrl ?? null,
      contactInfo: data.contactInfo ?? null,
      recommendationScore: score,
    })
    .returning();
  res.status(201).json(created);
});

// ── Delete tender ─────────────────────────────────────────────────────────
router.delete("/tenders/:id", async (req, res) => {
  const parsed = DeleteTenderParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const result = await db
    .delete(tendersTable)
    .where(eq(tendersTable.id, parsed.data.id))
    .returning();
  if (result.length === 0) {
    res.status(404).json({ error: "Tender not found" });
    return;
  }
  res.status(204).end();
});

// ── Import tenders from CSV ───────────────────────────────────────────────
router.post("/tenders/import-csv", async (req, res) => {
  const parsed = ImportTendersCsvBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const rows = parseCsv(parsed.data.csv);
  if (rows.length < 2) {
    res.status(400).json({ error: "CSV must have a header row and at least one data row" });
    return;
  }
  const headers = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const idx = (name: string) => headers.indexOf(name);
  const required = ["title", "agency", "description"];
  for (const r of required) {
    if (idx(r) === -1) {
      res.status(400).json({
        error: `CSV missing required column: ${r}. Expected: title, agency, description (optional: category, deadline, value_amount, source_url, contact_info)`,
      });
      return;
    }
  }

  let imported = 0;
  let skipped = 0;
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const title = row[idx("title")]?.trim();
    const agency = row[idx("agency")]?.trim();
    const description = row[idx("description")]?.trim();
    if (!title || !agency || !description) {
      skipped++;
      continue;
    }
    const category = idx("category") >= 0 ? row[idx("category")]?.trim() || "General" : "General";
    const deadlineStr = idx("deadline") >= 0 ? row[idx("deadline")]?.trim() : "";
    const deadline = deadlineStr ? new Date(deadlineStr) : null;
    const valueAmount = idx("value_amount") >= 0 ? row[idx("value_amount")]?.trim() || null : null;
    const sourceUrl = idx("source_url") >= 0 ? row[idx("source_url")]?.trim() || null : null;
    const contactInfo = idx("contact_info") >= 0 ? row[idx("contact_info")]?.trim() || null : null;
    const score = scoreTender(title, description, category);
    await db.insert(tendersTable).values({
      title,
      agency,
      description,
      category,
      deadline: deadline && !isNaN(deadline.getTime()) ? deadline : null,
      valueAmount,
      sourceUrl,
      contactInfo,
      recommendationScore: score,
    });
    imported++;
  }
  res.json({ imported, skipped });
});

// ── Extract tender from pasted text using AI ──────────────────────────────
router.post("/tenders/extract-from-text", async (req, res) => {
  const parsed = ExtractTenderFromTextBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }
  const { text, sourceUrl } = parsed.data;
  if (text.trim().length < 30) {
    res.status(400).json({ error: "Pasted text is too short to extract a tender" });
    return;
  }

  try {
    const meta        = extractTenderMetadata(text);
    const title       = meta.title    ?? "Needs review — title not detected";
    const agency      = meta.agency   ?? "Needs review — agency not detected";
    const description = meta.description || text.slice(0, 800);
    const category    = meta.category;
    const score       = scoreTender(title, description, category);
    const deadline    = meta.deadline ? new Date(meta.deadline) : null;

    const [created] = await db
      .insert(tendersTable)
      .values({
        title,
        agency,
        description,
        category,
        deadline:    deadline && !isNaN(deadline.getTime()) ? deadline : null,
        valueAmount: meta.valueAmount ?? null,
        sourceUrl:   sourceUrl ?? null,
        contactInfo: meta.contactInfo ?? null,
        recommendationScore: score,
      })
      .returning();
    res.status(201).json({ ...created, needsReview: meta.needsReview });
  } catch (err) {
    console.error("[tender extract] failed:", err);
    res.status(500).json({ error: "Extraction failed. Please try again or add manually." });
  }
});

// ── Generate proposal from tender — DEPRECATED (use POST /opportunities/:id/generate-proposal) ──
router.post("/tenders/:id/generate-proposal", (req, res) => {
  const id = req.params.id;
  res.set("Location", `/api/opportunities/${id}/generate-proposal`);
  res.status(410).json({
    error: "This endpoint has been retired. Use POST /api/opportunities/:id/generate-proposal instead.",
    canonical: `/api/opportunities/${id}/generate-proposal`,
  });
});


export default router;
