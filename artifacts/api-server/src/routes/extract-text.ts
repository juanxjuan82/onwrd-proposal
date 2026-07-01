import { Router } from "express";
import multer from "multer";
import mammoth from "mammoth";
// pdf-parse exposes its real implementation behind a debug-mode wrapper that
// tries to read a sample PDF off disk on import. Hit the lib file directly.
import pdfParse from "pdf-parse/lib/pdf-parse.js";

const router = Router();
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
});

const uploadSingle = upload.single("file");

router.post("/extract-text", (req, res, next) => {
  uploadSingle(req, res, (err: unknown) => {
    if (err) {
      const e = err as { code?: string; message?: string };
      if (e.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({
          error: `File is too large. Max size is ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB.`,
        });
        return;
      }
      req.log.error({ err }, "Upload failed");
      res.status(400).json({ error: e.message ?? "Upload failed" });
      return;
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }

  const { mimetype, originalname, buffer } = req.file;
  const name = originalname.toLowerCase();

  try {
    if (
      mimetype ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      name.endsWith(".docx")
    ) {
      const result = await mammoth.extractRawText({ buffer });
      res.json({ text: result.value });
      return;
    }

    if (mimetype === "application/pdf" || name.endsWith(".pdf")) {
      const result = await pdfParse(buffer);
      const text = (result.text ?? "").trim();
      if (!text) {
        res.status(400).json({
          error:
            "No selectable text found in this PDF. It may be a scanned image — try copy/pasting the text instead.",
        });
        return;
      }
      res.json({ text });
      return;
    }

    if (mimetype === "text/plain" || name.endsWith(".txt")) {
      res.json({ text: buffer.toString("utf-8") });
      return;
    }

    res.status(400).json({
      error:
        "Unsupported file type. Please upload a .pdf, .docx, or .txt file.",
    });
  } catch (err) {
    req.log.error({ err }, "Error extracting text from file");
    res.status(500).json({ error: "Failed to extract text from file" });
  }
});

export default router;
