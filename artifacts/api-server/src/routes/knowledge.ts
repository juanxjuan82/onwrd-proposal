import { Router } from "express";
import multer from "multer";
import mammoth from "mammoth";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { db } from "@workspace/db";
import { knowledgeDocumentsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

const router = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ── Shared crawl helpers ───────────────────────────────────────────────────
async function crawlFetch(url: string): Promise<string> {
  const r = await fetch(url, {
    headers: { "User-Agent": "ONWRD-Proposal-Desk/1.0 (internal crawler)" },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`);
  return r.text();
}

function crawlExtractTitle(html: string, fallback: string): string {
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1];
  if (ogTitle) return ogTitle.trim();
  const tag = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
  return tag ? tag.replace(/\s*[|–—-].*$/, "").trim() : fallback;
}

function crawlHtmlToText(html: string, maxChars = 12000): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&#\d+;/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, maxChars);
}

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

// ── Crawl ONWRD website for case studies ──────────────────────────────────
router.post("/knowledge/crawl-case-studies", async (req, res) => {
  const BASE_DOMAIN = "https://onwrdadvisors.com";
  const CASE_STUDY_PATH = "/case-study/";

  async function discoverCaseStudyUrls(): Promise<string[]> {
    const urls = new Set<string>();
    const sitemapsToTry = [
      `${BASE_DOMAIN}/sitemap.xml`,
      `${BASE_DOMAIN}/sitemap_index.xml`,
      `${BASE_DOMAIN}/page-sitemap.xml`,
      `${BASE_DOMAIN}/post-sitemap.xml`,
    ];

    for (const sitemapUrl of sitemapsToTry) {
      try {
        const xml = await crawlFetch(sitemapUrl);
        // Find all <loc> entries pointing to case studies
        const locMatches = xml.matchAll(/<loc>([^<]+)<\/loc>/gi);
        for (const m of locMatches) {
          const url = m[1].trim();
          if (url.includes(CASE_STUDY_PATH) && url !== `${BASE_DOMAIN}${CASE_STUDY_PATH}`) {
            urls.add(url);
          }
          // Follow sub-sitemaps (sitemap index)
          if (url.endsWith(".xml") && url !== sitemapUrl) {
            try {
              const subXml = await crawlFetch(url);
              const subMatches = subXml.matchAll(/<loc>([^<]+)<\/loc>/gi);
              for (const sm of subMatches) {
                const subUrl = sm[1].trim();
                if (subUrl.includes(CASE_STUDY_PATH) && subUrl !== `${BASE_DOMAIN}${CASE_STUDY_PATH}`) {
                  urls.add(subUrl);
                }
              }
            } catch { /* skip broken sub-sitemaps */ }
          }
        }
        if (urls.size > 0) break; // stop trying sitemaps once we have results
      } catch { /* try next sitemap */ }
    }

    return Array.from(urls);
  }

  try {
    const discovered = await discoverCaseStudyUrls();

    if (discovered.length === 0) {
      res.status(404).json({
        error: "No case study URLs found in the sitemap. The sitemap may be structured differently.",
        hint: "Try adding case studies manually or check onwrdadvisors.com/sitemap.xml",
      });
      return;
    }

    // Get existing sourceUrls to detect duplicates
    const existing = await db
      .select({ id: knowledgeDocumentsTable.id, sourceUrl: knowledgeDocumentsTable.sourceUrl })
      .from(knowledgeDocumentsTable);
    const existingByUrl = new Map(existing.filter((d) => d.sourceUrl).map((d) => [d.sourceUrl!, d.id]));

    const results = { created: 0, updated: 0, failed: 0, total: discovered.length };

    for (const url of discovered) {
      try {
        const html = await crawlFetch(url);
        const slug = url.replace(/\/$/, "").split("/").pop() ?? url;
        const title = crawlExtractTitle(html, slug.replace(/-/g, " "));
        const content = crawlHtmlToText(html);

        if (!content || content.length < 100) {
          results.failed++;
          continue;
        }

        const existingId = existingByUrl.get(url);
        if (existingId) {
          await db
            .update(knowledgeDocumentsTable)
            .set({ title, content, updatedAt: new Date() })
            .where(eq(knowledgeDocumentsTable.id, existingId));
          results.updated++;
        } else {
          await db.insert(knowledgeDocumentsTable).values({
            title,
            content,
            docType: "case_study",
            isApproved: false,
            sourceUrl: url,
            tags: JSON.stringify(["case_study", "website"]),
          });
          results.created++;
        }
      } catch {
        results.failed++;
      }
    }

    res.json(results);
  } catch (err) {
    req.log.error({ err }, "Error crawling case studies");
    res.status(500).json({ error: "Failed to crawl case studies" });
  }
});

// ── Crawl ONWRD team bios ─────────────────────────────────────────────────
router.post("/knowledge/crawl-bios", async (req, res) => {
  const BIO_URL = "https://onwrdadvisors.com/who-we-are";

  try {
    const html = await crawlFetch(BIO_URL);
    const title = "ONWRD Team Bios";
    const content = crawlHtmlToText(html, 16000);

    if (!content || content.length < 100) {
      res.status(422).json({ error: "Could not extract meaningful content from the page." });
      return;
    }

    const existing = await db
      .select({ id: knowledgeDocumentsTable.id })
      .from(knowledgeDocumentsTable)
      .where(eq(knowledgeDocumentsTable.sourceUrl, BIO_URL));

    if (existing.length > 0) {
      await db
        .update(knowledgeDocumentsTable)
        .set({ title, content, updatedAt: new Date() })
        .where(eq(knowledgeDocumentsTable.sourceUrl, BIO_URL));
      res.json({ created: 0, updated: 1 });
    } else {
      await db.insert(knowledgeDocumentsTable).values({
        title,
        content,
        docType: "bio",
        isApproved: false,
        sourceUrl: BIO_URL,
        tags: JSON.stringify(["team", "bios", "website"]),
      });
      res.json({ created: 1, updated: 0 });
    }
  } catch (err) {
    req.log.error({ err }, "Error crawling team bios");
    res.status(500).json({ error: "Failed to crawl team bios" });
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
