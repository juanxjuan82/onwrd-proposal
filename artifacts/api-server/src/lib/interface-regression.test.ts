import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const frontendRoot = new URL("../../../proposal-generator/src/", import.meta.url);

async function page(path: string): Promise<string> {
  return readFile(new URL(path, frontendRoot), "utf8");
}

describe("responsive proposal interfaces", () => {
  it("keeps the public intake grids and header mobile-safe", async () => {
    const source = await page("pages/intake.tsx");
    assert.match(source, /grid-cols-1 sm:grid-cols-2/);
    assert.match(source, /px-4 sm:px-6/);
    assert.match(source, /w-4 sm:w-6/);
    assert.match(source, /hidden sm:inline/);
  });

  it("keeps Paste Text text-only and Import responsible for file and URL acquisition", async () => {
    const source = await page("pages/new-proposal.tsx");
    const pasteStart = source.indexOf("{/* ── Paste panel");
    const pasteEnd = source.indexOf("{/* ── Step 1: guided intake form", pasteStart);
    const pastePanel = source.slice(pasteStart, pasteEnd);
    const importStart = source.indexOf("{/* ── Import (file / URL)");
    const importPanel = source.slice(importStart, pasteStart);

    assert.match(pastePanel, /textarea-paste-text/);
    assert.match(pastePanel, /Brief looks good/);
    assert.match(pastePanel, /button-create-opportunity/);
    assert.doesNotMatch(pastePanel, /fileInputRef|input-import-url|TED Europa|Browse RFP sources/);
    assert.match(importPanel, /dropzone-import-file/);
    assert.match(importPanel, /input-import-url/);
    assert.match(source, /const \[importText, setImportText\]/);
    assert.match(source, /const selection = \+\+fileSelectionRef\.current;/);
    assert.match(source, /setImportText\(""\);\s+setPasteFileExtracting\(true\);/);
    assert.match(source, /if \(selection !== fileSelectionRef\.current\) return;/);
    assert.match(source, /if \(!extracted\) throw new Error\("No readable text was found in this file\."\);/);
    assert.match(source, /pasteFileExtracting[\s\S]+Boolean\(pasteFileError\)[\s\S]+pasteFile !== null && importText\.trim\(\)\.length === 0/);
  });

  it("renders source lifecycle controls and actionable health detail", async () => {
    const source = await page("pages/settings-sources.tsx");
    for (const marker of [
      "SourceHealthBadge",
      "lastSuccessAt",
      "lastError",
      "recentFailures",
      "button-source-toggle-confirm",
      "input-delete-confirm",
      "select-source-adapter",
    ]) {
      assert.ok(source.includes(marker), `Expected source settings to include ${marker}`);
    }
  });
});

describe("source lifecycle route contracts", () => {
  it("invalidates changed configuration and requires persisted test records", async () => {
    const route = await readFile(new URL("../routes/tender-intelligence.ts", import.meta.url), "utf8");
    assert.match(route, /if \(configChanged \|\| validated\.definition\.blockedReason\) \{\s+updates\.active = false;/);
    assert.match(route, /updates\.configurationVersion = sql/);
    assert.match(route, /eq\(crawlerRunsTable\.sourceConfigurationVersion, current\.configurationVersion\)/);
    assert.match(route, /gte\(crawlerRunsTable\.itemsNew, 1\)/);
    assert.match(route, /\.update\(tenderSourcesTable\)[\s\S]+eq\(tenderSourcesTable\.configurationVersion, current\.configurationVersion\)[\s\S]+source_configuration_conflict/);
  });

  it("defensively filters unsupported and blocked adapters from scheduled crawls", async () => {
    const crawler = await readFile(new URL("../crawlers/index.ts", import.meta.url), "utf8");
    assert.match(crawler, /queriedSources\.filter/);
    assert.match(crawler, /Boolean\(definition && !definition\.blockedReason\)/);
    assert.match(crawler, /sourceConfigurationVersion: source\.configurationVersion/);
    assert.match(crawler, /eq\(tenderSourcesTable\.configurationVersion, source\.configurationVersion\)/);
    assert.match(crawler, /if \(!acquired\)[\s\S]+try \{\s+const queriedSources/);
    assert.match(crawler, /return \{[\s\S]+quotaErrorHit:\s+false,[\s\S]+\} finally \{\s+await releaseCrawlLock\(\);/);
  });
});