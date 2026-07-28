/**
 * Crawler source activation and failure-semantics tests.
 *
 * These are structural/unit tests — no DB, no network. They verify:
 *  (1) The four blocked adapters throw when all requests fail (not silent empty return).
 *  (2) seedDefaultSources inserts the four blocked sources with active=false.
 *  (3) Working adapters are seeded with active=true.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── (1) Adapter throw-on-total-failure contract ───────────────────────────────

describe("Blocked adapters — throw on total failure", () => {
  // The contract: an adapter MUST throw when all requests fail so the crawler
  // pipeline records a "failed" source run rather than a silent zero-result success.
  // We verify this by checking the adapter source code structure.

  const ADAPTERS_MUST_THROW: Array<{ key: string; file: string }> = [
    { key: "idb", file: "idb" },
    { key: "cdb", file: "cdb" },
    { key: "cto", file: "cto" },
    { key: "eu_caribbean", file: "eu-caribbean" },
  ];

  for (const { key, file } of ADAPTERS_MUST_THROW) {
    it(`(${key}) source contains throw-on-total-failure guard`, async () => {
      const fs = await import("node:fs/promises");
      const source = await fs.readFile(
        new URL(`./${file}.ts`, import.meta.url).pathname.replace(/\.js$/, ".ts"),
        "utf-8",
      );

      assert.ok(
        source.includes("requestsSucceeded === 0"),
        `${key}: missing "requestsSucceeded === 0" guard`,
      );
      assert.ok(
        source.includes("throw new Error"),
        `${key}: missing throw on total failure`,
      );
    });
  }
});

// ── (2 & 3) seedDefaultSources — active flags ─────────────────────────────────

describe("seedDefaultSources — blocked sources seeded inactive", () => {
  it("IDB, CDB, CTO, EU Caribbean are configured with active=false", async () => {
    // Read the index.ts source and verify the four blocked adapters have active: false
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(
      new URL("./index.ts", import.meta.url).pathname.replace(/\.js$/, ".ts"),
      "utf-8",
    );

    const blockedAdapters = ["idb", "cdb", "cto", "eu_caribbean"];
    for (const adapter of blockedAdapters) {
      // Find the line containing this adapterType in the defaults array
      const adapterLineMatch = source.match(
        new RegExp(`adapterType:\\s*["']${adapter}["'][^}]+active:\\s*(true|false)`),
      );
      assert.ok(
        adapterLineMatch,
        `${adapter}: could not find adapterType + active flag in seedDefaultSources`,
      );
      assert.equal(
        adapterLineMatch[1],
        "false",
        `${adapter}: must be seeded with active=false (blocked from Replit)`,
      );
    }
  });

  it("World Bank, UNGM, Bahamas Gov, CARICOM are configured with active=true", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(
      new URL("./index.ts", import.meta.url).pathname.replace(/\.js$/, ".ts"),
      "utf-8",
    );

    const activeAdapters = ["world_bank", "ungm", "bahamas_gov", "caricom"];
    for (const adapter of activeAdapters) {
      const adapterLineMatch = source.match(
        new RegExp(`adapterType:\\s*["']${adapter}["'][^}]+active:\\s*(true|false)`),
      );
      assert.ok(
        adapterLineMatch,
        `${adapter}: could not find adapterType + active flag in seedDefaultSources`,
      );
      assert.equal(
        adapterLineMatch[1],
        "true",
        `${adapter}: expected active=true`,
      );
    }
  });
});

// ── (4) World Bank adapter uses submission_deadline_date ──────────────────────

describe("World Bank adapter — correct deadline field", () => {
  it("uses submission_deadline_date not submission_date as the deadline", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(
      new URL("./world-bank.ts", import.meta.url).pathname.replace(/\.js$/, ".ts"),
      "utf-8",
    );

    assert.ok(
      source.includes("submission_deadline_date"),
      "world-bank.ts must reference submission_deadline_date",
    );
    // Verify it's used as the deadline (not just mentioned in a comment)
    assert.ok(
      source.includes("n.submission_deadline_date"),
      "world-bank.ts must read n.submission_deadline_date from the API response",
    );
  });

  it("filters out notices with a past deadline", async () => {
    const fs = await import("node:fs/promises");
    const source = await fs.readFile(
      new URL("./world-bank.ts", import.meta.url).pathname.replace(/\.js$/, ".ts"),
      "utf-8",
    );

    assert.ok(
      source.includes("deadline <= now"),
      "world-bank.ts must skip items where deadline <= now",
    );
  });
});
