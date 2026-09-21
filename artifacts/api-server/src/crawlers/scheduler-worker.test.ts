import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { escapeHtml, getDigestAppBase, runScheduledCrawl, abandonExpiredDrafts } from "./scheduler.js";

test("HTTP server does not start the production scheduler", () => {
  const serverSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(serverSource, /startScheduler|node-cron/);
});

test("one-shot worker and cleanup entry points are exported", () => {
  assert.equal(typeof runScheduledCrawl, "function");
  assert.equal(typeof abandonExpiredDrafts, "function");
});

test("development digest URL is not used in production", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAppUrl = process.env.APP_URL;
  try {
    process.env.NODE_ENV = "production";
    process.env.APP_URL = "https://example.com/";
    assert.equal(getDigestAppBase(), "https://example.com");
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = originalAppUrl;
  }
});

test("digest HTML escaping protects crawler-controlled text", () => {
  assert.equal(
    escapeHtml(`<script>alert("x")</script> & 'quoted'`),
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quoted&#39;",
  );
});