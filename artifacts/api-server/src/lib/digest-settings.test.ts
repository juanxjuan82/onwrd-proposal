import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_DIGEST_RECIPIENTS,
  parseDigestRecipients,
  shouldUpgradeLegacyRecipients,
  validateDigestRecipients,
} from "./digest-settings.js";

describe("digest recipient settings", () => {
  it("defines the three requested morning digest recipients", () => {
    assert.deepEqual([...DEFAULT_DIGEST_RECIPIENTS], [
      "r.dean@onwrdadvisors.com",
      "s.esmeralda@onwrdadvisors.com",
      "j.aymes@onwrdadvisors.com",
    ]);
  });

  it("normalizes, deduplicates, and rejects malformed recipients", () => {
    const result = validateDigestRecipients([
      " R.DEAN@ONWRDADVISORS.COM ",
      "r.dean@onwrdadvisors.com",
      "s.esmeralda@onwrdadvisors.com",
      "not-an-email",
      "",
    ]);
    assert.deepEqual(result.emails, [
      "r.dean@onwrdadvisors.com",
      "s.esmeralda@onwrdadvisors.com",
    ]);
    assert.deepEqual(result.invalid, ["not-an-email", ""]);
  });

  it("handles malformed persisted JSON without throwing", () => {
    assert.deepEqual(parseDigestRecipients("{not-json"), []);
  });

  it("recognizes the previous one-recipient default for a safe upgrade", () => {
    assert.equal(shouldUpgradeLegacyRecipients(["j.aymes@onwrdadvisors.com"]), true);
    assert.equal(shouldUpgradeLegacyRecipients([...DEFAULT_DIGEST_RECIPIENTS]), false);
  });
});

describe("digest delivery boundaries", () => {
  it("applies actionable filtering to both scheduled and test sends", async () => {
    const [schedulerSource, routeSource] = await Promise.all([
      readFile(new URL("../crawlers/scheduler.ts", import.meta.url), "utf8"),
      readFile(new URL("../routes/tender-intelligence.ts", import.meta.url), "utf8"),
    ]);

    for (const source of [schedulerSource, routeSource]) {
      assert.match(source, /isNotNull\(discoveredTendersTable\.opportunityId\)/);
      assert.match(source, /filterActionableDigestTenders\(allTenders\)/);
      assert.match(source, /to:\s*emails/);
    }
  });

  it("prevents manual promotion from bypassing the deterministic gate", async () => {
    const routeSource = await readFile(
      new URL("../routes/tender-intelligence.ts", import.meta.url),
      "utf8",
    );
    assert.match(routeSource, /evaluateCrawlerEligibility\(\{/);
    assert.match(routeSource, /code:\s*"ineligible_discovery"/);
  });
});