import { ReplitConnectors } from "@replit/connectors-sdk";

interface Document {
  documentId: string;
  title: string;
}

interface BatchUpdateResponse {
  documentId: string;
}

interface Block {
  type: "text" | "table";
  lines?: string[];
  headers?: string[];
  rows?: string[][];
}

async function docsRequest(
  path: string,
  options: RequestInit,
  accessToken?: string,
): Promise<Response> {
  if (accessToken) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers as Record<string, string>),
    };
    return fetch(`https://docs.googleapis.com${path}`, { ...options, headers });
  }
  const connectors = new ReplitConnectors();
  return connectors.proxy("google-docs", path, options);
}

async function batchUpdate(
  documentId: string,
  requests: object[],
  accessToken?: string,
): Promise<BatchUpdateResponse> {
  const response = await docsRequest(
    `/v1/documents/${documentId}:batchUpdate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests }),
    },
    accessToken,
  );
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to update Google Doc: ${response.status} ${errorText}`);
  }
  return response.json() as Promise<BatchUpdateResponse>;
}

async function getDocument(
  documentId: string,
  accessToken?: string,
): Promise<Record<string, unknown>> {
  const response = await docsRequest(
    `/v1/documents/${documentId}`,
    { method: "GET", headers: { "Content-Type": "application/json" } },
    accessToken,
  );
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to get Google Doc: ${response.status} ${errorText}`);
  }
  return response.json() as Promise<Record<string, unknown>>;
}

export async function createGoogleDoc(
  title: string,
  accessToken?: string,
): Promise<Document> {
  const response = await docsRequest(
    "/v1/documents",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    },
    accessToken,
  );
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create Google Doc: ${response.status} ${errorText}`);
  }
  return response.json() as Promise<Document>;
}

/** Parse a markdown table row into cell strings */
function parseTableRow(line: string): string[] {
  return line
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim());
}

/** Split proposal text into alternating text blocks and table blocks */
function parseContentBlocks(content: string): Block[] {
  const lines = content.split("\n");
  const blocks: Block[] = [];
  let textLines: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const trimmed = lines[i].trim();

    if (
      trimmed.startsWith("|") &&
      trimmed.endsWith("|") &&
      i + 1 < lines.length &&
      /^\|[\s\-:|]+\|/.test(lines[i + 1].trim())
    ) {
      if (textLines.length > 0) {
        blocks.push({ type: "text", lines: textLines });
        textLines = [];
      }

      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        tableLines.push(lines[i]);
        i++;
      }

      const headers = parseTableRow(tableLines[0]);
      const rows: string[][] = [];
      for (let j = 2; j < tableLines.length; j++) {
        const t = tableLines[j].trim();
        if (t && t !== "|") rows.push(parseTableRow(tableLines[j]));
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    textLines.push(lines[i]);
    i++;
  }

  if (textLines.length > 0) {
    blocks.push({ type: "text", lines: textLines });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Markdown line processing
// ---------------------------------------------------------------------------

type LineKind =
  | "title"
  | "h1"
  | "h2"
  | "h3"
  | "bullet"
  | "numbered"
  | "blank"
  | "plain";

interface InlineRange {
  start: number;
  end: number;
}

interface ProcessedLine {
  kind: LineKind;
  text: string; // cleaned text with markdown markers stripped
  bold: InlineRange[];
  italic: InlineRange[];
}

/**
 * Strip inline markdown markers ( **bold**, *italic* ) and return the
 * cleaned text plus offsets of the styled ranges within that cleaned text.
 */
function isWordChar(ch: string | undefined): boolean {
  if (!ch) return false;
  return /\w/.test(ch);
}

/** True if `*` at position i looks like it opens an inline span. */
function looksLikeOpener(input: string, i: number, marker: string): boolean {
  // The character right BEFORE the marker should NOT be a word character
  // (so `5*2` won't be treated as italic opener).
  const before = i > 0 ? input[i - 1] : undefined;
  if (isWordChar(before)) return false;
  // The character right AFTER the marker must exist and not be space.
  const after = input[i + marker.length];
  if (after === undefined || after === " ") return false;
  return true;
}

/** True if a closing marker at position end is valid for the given opener. */
function looksLikeCloser(input: string, end: number, marker: string): boolean {
  const before = input[end - 1];
  if (before === " " || before === undefined) return false;
  // Don't close mid-word for italic if next char is also `*` (would be bold continuation)
  return true;
}

function processInline(input: string): {
  text: string;
  bold: InlineRange[];
  italic: InlineRange[];
} {
  const bold: InlineRange[] = [];
  const italic: InlineRange[] = [];
  let out = "";
  let i = 0;

  while (i < input.length) {
    // **bold**
    if (input[i] === "*" && input[i + 1] === "*") {
      if (looksLikeOpener(input, i, "**")) {
        // Find next "**" that isn't part of "***"
        let searchFrom = i + 2;
        let end = -1;
        while (searchFrom < input.length) {
          const cand = input.indexOf("**", searchFrom);
          if (cand === -1) break;
          if (looksLikeCloser(input, cand, "**")) {
            end = cand;
            break;
          }
          searchFrom = cand + 2;
        }
        if (end > i + 2) {
          const inner = input.slice(i + 2, end);
          const start = out.length;
          // Recursively process inner so **_foo_** style still works
          const innerProc = processInline(inner);
          for (const r of innerProc.italic) {
            italic.push({ start: start + r.start, end: start + r.end });
          }
          out += innerProc.text;
          bold.push({ start, end: out.length });
          i = end + 2;
          continue;
        }
      }
    }
    // *italic* (single asterisk)
    if (input[i] === "*" && input[i + 1] !== "*") {
      if (looksLikeOpener(input, i, "*")) {
        // Find next single `*` that isn't part of `**`
        let searchFrom = i + 1;
        let end = -1;
        while (searchFrom < input.length) {
          const cand = input.indexOf("*", searchFrom);
          if (cand === -1) break;
          // Skip if it's actually `**`
          if (input[cand + 1] === "*" || input[cand - 1] === "*") {
            searchFrom = cand + 1;
            continue;
          }
          if (looksLikeCloser(input, cand, "*")) {
            end = cand;
            break;
          }
          searchFrom = cand + 1;
        }
        if (end > i + 1) {
          const inner = input.slice(i + 1, end);
          const start = out.length;
          out += inner;
          italic.push({ start, end: out.length });
          i = end + 1;
          continue;
        }
      }
    }
    out += input[i];
    i++;
  }

  return { text: out, bold, italic };
}

function processLine(raw: string): ProcessedLine {
  const trimmed = raw.trim();

  // Blank
  if (!trimmed) {
    return { kind: "blank", text: "", bold: [], italic: [] };
  }

  // Decorative horizontal rule lines (━━━ / --- / ===) → render as a
  // blank paragraph so they don't appear as raw character noise.
  if (/^[━─=\-_*]{3,}$/.test(trimmed)) {
    return { kind: "blank", text: "", bold: [], italic: [] };
  }

  // The very specific opening title line
  if (trimmed === "ONWRD PROJECT PROPOSAL") {
    return { kind: "title", text: trimmed, bold: [], italic: [] };
  }

  // Markdown headings: # / ## / ###
  const md = raw.match(/^\s*(#{1,3})\s+(.*\S)\s*$/);
  if (md) {
    const level = md[1].length;
    const inner = processInline(md[2]);
    return {
      kind: level === 1 ? "h1" : level === 2 ? "h2" : "h3",
      text: inner.text,
      bold: inner.bold,
      italic: inner.italic,
    };
  }

  // "1. EXECUTIVE SUMMARY" — section heading (mostly uppercase title)
  if (/^\d{1,2}\.\s+\S/.test(trimmed) && !/^\d+\.\d+/.test(trimmed)) {
    const titlePart = trimmed.replace(/^\d{1,2}\.\s+/, "");
    const uppers = (titlePart.match(/[A-Z]/g) ?? []).length;
    const lowers = (titlePart.match(/[a-z]/g) ?? []).length;
    if (uppers > lowers) {
      return { kind: "h1", text: trimmed, bold: [], italic: [] };
    }
  }

  // "1.1 Subsection"
  if (/^\d+\.\d+\s+[A-Za-z]/.test(trimmed)) {
    return { kind: "h2", text: trimmed, bold: [], italic: [] };
  }

  // Bullet line: -, *, • or middle-dot
  const bullet = raw.match(/^\s*[-*•]\s+(.*)$/);
  if (bullet) {
    const inner = processInline(bullet[1]);
    return {
      kind: "bullet",
      text: inner.text,
      bold: inner.bold,
      italic: inner.italic,
    };
  }

  // Numbered list item: "1. text" or "1) text" with mixed-case content
  // (UPPERCASE-dominant numbered lines were already classified as h1 above).
  const numbered = raw.match(/^\s*\d+[.)]\s+(.*)$/);
  if (numbered) {
    const inner = processInline(numbered[1]);
    return {
      kind: "numbered",
      text: inner.text,
      bold: inner.bold,
      italic: inner.italic,
    };
  }

  // Plain paragraph — process inline formatting
  const inner = processInline(raw);
  return {
    kind: "plain",
    text: inner.text,
    bold: inner.bold,
    italic: inner.italic,
  };
}

const HEADING_STYLE: Partial<Record<LineKind, string>> = {
  title: "TITLE",
  h1: "HEADING_1",
  h2: "HEADING_2",
  h3: "HEADING_3",
};

/**
 * Insert a single text block (a contiguous run of non-table lines) into the
 * document at startIndex. Applies markdown formatting (headings, bullets,
 * bold, italic). Returns the new docIndex (one past the last inserted char).
 */
async function insertTextBlock(
  documentId: string,
  startIndex: number,
  rawLines: string[],
  accessToken?: string,
): Promise<number> {
  // Process every line first
  let processed = rawLines.map(processLine);

  // Trim leading/trailing blanks so blocks don't accumulate excess whitespace
  while (processed.length && processed[0].kind === "blank") processed.shift();
  while (
    processed.length &&
    processed[processed.length - 1].kind === "blank"
  ) {
    processed.pop();
  }

  if (processed.length === 0) return startIndex;

  // Build the combined text + per-paragraph absolute-index metadata
  interface ParaInfo {
    kind: LineKind;
    paraStart: number;
    paraEnd: number; // exclusive — points at char *after* the paragraph's \n
    bold: InlineRange[];
    italic: InlineRange[];
  }

  const paras: ParaInfo[] = [];
  let combined = "";

  for (const line of processed) {
    const absStart = startIndex + combined.length;
    combined += line.text + "\n";
    const absEnd = startIndex + combined.length;
    paras.push({
      kind: line.kind,
      paraStart: absStart,
      paraEnd: absEnd,
      bold: line.bold.map((r) => ({
        start: absStart + r.start,
        end: absStart + r.end,
      })),
      italic: line.italic.map((r) => ({
        start: absStart + r.start,
        end: absStart + r.end,
      })),
    });
  }

  // Single insert for the whole block
  await batchUpdate(
    documentId,
    [{ insertText: { location: { index: startIndex }, text: combined } }],
    accessToken,
  );

  // Build all style requests (these don't shift indices)
  const styleRequests: object[] = [];

  // Paragraph styles: explicit headings, otherwise normalize to NORMAL_TEXT
  // so previous heading styling never bleeds into following paragraphs.
  for (const p of paras) {
    const named = HEADING_STYLE[p.kind] ?? "NORMAL_TEXT";
    styleRequests.push({
      updateParagraphStyle: {
        range: { startIndex: p.paraStart, endIndex: p.paraEnd },
        paragraphStyle: { namedStyleType: named },
        fields: "namedStyleType",
      },
    });
  }

  // Bullets / numbered lists: group consecutive same-kind paragraphs into a
  // single createParagraphBullets call so they share one list.
  let bi = 0;
  while (bi < paras.length) {
    const kind = paras[bi].kind;
    if (kind === "bullet" || kind === "numbered") {
      let bj = bi;
      while (bj < paras.length && paras[bj].kind === kind) bj++;
      const start = paras[bi].paraStart;
      const end = paras[bj - 1].paraEnd;
      styleRequests.push({
        createParagraphBullets: {
          range: { startIndex: start, endIndex: end },
          bulletPreset:
            kind === "bullet"
              ? "BULLET_DISC_CIRCLE_SQUARE"
              : "NUMBERED_DECIMAL_ALPHA_ROMAN",
        },
      });
      bi = bj;
    } else {
      bi++;
    }
  }

  // Inline bold / italic
  for (const p of paras) {
    for (const b of p.bold) {
      if (b.end > b.start) {
        styleRequests.push({
          updateTextStyle: {
            range: { startIndex: b.start, endIndex: b.end },
            textStyle: { bold: true },
            fields: "bold",
          },
        });
      }
    }
    for (const it of p.italic) {
      if (it.end > it.start) {
        styleRequests.push({
          updateTextStyle: {
            range: { startIndex: it.start, endIndex: it.end },
            textStyle: { italic: true },
            fields: "italic",
          },
        });
      }
    }
  }

  if (styleRequests.length > 0) {
    try {
      await batchUpdate(documentId, styleRequests, accessToken);
    } catch (err) {
      console.error("Could not apply text-block styles:", err);
    }
  }

  return startIndex + combined.length;
}

export async function appendContentWithLogo(
  documentId: string,
  content: string,
  accessToken?: string,
): Promise<void> {
  const blocks = parseContentBlocks(content);

  let docIndex = 1;

  for (const block of blocks) {
    if (block.type === "text") {
      docIndex = await insertTextBlock(
        documentId,
        docIndex,
        block.lines ?? [],
        accessToken,
      );
    } else {
      // Real Google Docs table
      const headers = block.headers ?? [];
      const rows = block.rows ?? [];
      const numRows = 1 + rows.length;
      const numCols = headers.length;
      if (numCols === 0) continue;

      // Insert empty table
      await batchUpdate(
        documentId,
        [
          {
            insertTable: {
              rows: numRows,
              columns: numCols,
              location: { index: docIndex },
            },
          },
        ],
        accessToken,
      );

      // Fetch the document to get actual cell indices
      const doc = await getDocument(documentId, accessToken);
      const bodyContent = (
        (doc.body as Record<string, unknown>).content as Record<
          string,
          unknown
        >[]
      ) ?? [];

      // Find the table we just inserted (nearest startIndex >= docIndex - 1)
      type TableEl = {
        startIndex: number;
        endIndex: number;
        table: {
          tableRows: {
            tableCells: {
              content: { startIndex: number }[];
            }[];
          }[];
        };
      };

      let tableEl: TableEl | null = null;
      for (const el of bodyContent) {
        if (
          el.table &&
          typeof el.startIndex === "number" &&
          el.startIndex >= docIndex - 1
        ) {
          tableEl = el as TableEl;
          break;
        }
      }

      if (!tableEl) {
        console.error("Could not find inserted table at index", docIndex);
        docIndex += numRows * (numCols * 2 + 1) + 1;
        continue;
      }

      // Cell text — strip inline markdown markers so cells aren't littered
      // with raw asterisks.
      const allRows = [headers, ...rows];
      const cellInsertions: { index: number; text: string }[] = [];

      for (let r = 0; r < allRows.length; r++) {
        const rowData = allRows[r];
        const tableRow = tableEl.table.tableRows[r];
        if (!tableRow) continue;
        for (let c = 0; c < rowData.length; c++) {
          const cell = tableRow.tableCells[c];
          if (!cell || !rowData[c]) continue;
          const cleaned = processInline(rowData[c]).text;
          cellInsertions.push({
            index: cell.content[0].startIndex,
            text: cleaned,
          });
        }
      }

      if (cellInsertions.length > 0) {
        // Insert in REVERSE index order so earlier cells aren't shifted
        cellInsertions.sort((a, b) => b.index - a.index);
        await batchUpdate(
          documentId,
          cellInsertions.map(({ index, text }) => ({
            insertText: { location: { index }, text },
          })),
          accessToken,
        );
      }

      // Bold the header row.
      // Cells were inserted in REVERSE index order, so each header cell's
      // current position is its original startIndex shifted right by the total
      // length of all PRIOR header cells already inserted (header cells have
      // the lowest indices in the table; body cells come after).
      try {
        const headerRow = tableEl.table.tableRows[0];
        if (headerRow) {
          const headerStyleRequests: object[] = [];
          let shift = 0;
          for (let c = 0; c < headers.length; c++) {
            const cell = headerRow.tableCells[c];
            if (!cell || !headers[c]) continue;
            const cleaned = processInline(headers[c]).text;
            if (!cleaned) continue;
            const startIdx = cell.content[0].startIndex + shift;
            headerStyleRequests.push({
              updateTextStyle: {
                range: {
                  startIndex: startIdx,
                  endIndex: startIdx + cleaned.length,
                },
                textStyle: { bold: true },
                fields: "bold",
              },
            });
            shift += cleaned.length;
          }
          if (headerStyleRequests.length > 0) {
            await batchUpdate(documentId, headerStyleRequests, accessToken);
          }
        }
      } catch (err) {
        console.error("Could not bold table header row:", err);
      }

      // tableEl.endIndex was captured before cell text was inserted.
      // Every character inserted into cells shifts content after the table,
      // so we must add the total inserted length to get the true new end.
      const totalCellTextLength = cellInsertions.reduce(
        (sum, c) => sum + c.text.length,
        0,
      );
      docIndex = tableEl.endIndex + totalCellTextLength;
    }
  }

  // Insert ONWRD logo at the very top
  const domain =
    process.env.REPLIT_DEV_DOMAIN ??
    process.env.REPLIT_DOMAINS?.split(",")[0];

  if (domain) {
    const logoUrl = `https://${domain}/onwrd-logo.png`;
    try {
      await batchUpdate(
        documentId,
        [{ insertText: { location: { index: 1 }, text: "\n\n" } }],
        accessToken,
      );
      await batchUpdate(
        documentId,
        [
          {
            insertInlineImage: {
              location: { index: 1 },
              uri: logoUrl,
              objectSize: {
                height: { magnitude: 36, unit: "PT" },
                width: { magnitude: 108, unit: "PT" },
              },
            },
          },
        ],
        accessToken,
      );
    } catch (err) {
      console.error("Could not insert logo into Google Doc:", err);
    }
  }
}
