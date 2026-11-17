import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SOURCE_ADAPTER_CATALOG,
  getSourceAdapterDefinition,
  getCrawlBlockReason,
  requiresControlledPilot,
  validateSourceConfiguration,
} from "../crawlers/index.js";
import { deriveSourceHealth } from "./source-health.js";

describe("source configuration guardrails", () => {
  it("publishes only registered adapters and marks blocked replacements", () => {
    assert.deepEqual(
      SOURCE_ADAPTER_CATALOG.filter((item) => item.recommended).map((item) => item.adapterType),
      ["world_bank", "bahamas_gov"],
    );
    for (const adapterType of ["idb", "cto", "eu_caribbean"]) {
      assert.match(getSourceAdapterDefinition(adapterType)?.blockedReason ?? "", /verified|Verify/i);
    }
    assert.match(getSourceAdapterDefinition("ungm")?.blockedReason ?? "", /robots\.txt|disallows/i);
    assert.equal(getSourceAdapterDefinition("caricom")?.blockedReason, undefined);
    assert.equal(getSourceAdapterDefinition("caricom")?.recommended, false);
    assert.equal(getCrawlBlockReason("caricom"), null);
    assert.equal(requiresControlledPilot("caricom"), true);
    assert.equal(getSourceAdapterDefinition("cdb")?.blockedReason, undefined);
    assert.equal(getSourceAdapterDefinition("ted_europa"), undefined);
  });

  it("rejects unsupported adapters and off-domain URLs", () => {
    assert.deepEqual(
      validateSourceConfiguration({
        adapterType: "ted_europa",
        url: "https://ted.europa.eu/",
      }),
      { error: "Unsupported adapter. Choose a registered crawler adapter." },
    );
    const offDomain = validateSourceConfiguration({
      adapterType: "world_bank",
      url: "https://example.com/procurement",
    });
    assert.ok("error" in offDomain);
    assert.match(offDomain.error, /only supports registered/i);
  });

  it("accepts approved registered adapter domains", () => {
    const result = validateSourceConfiguration({
      adapterType: "bahamas_gov",
      url: "https://www.bahamas.gov.bs/tender-notices",
      approvedDomains: ["bahamas.gov.bs"],
    });
    assert.ok(!("error" in result));
    assert.equal(result.definition.supportsBrowser, true);
    assert.deepEqual(result.domains, ["bahamas.gov.bs"]);
  });
});

describe("source health derivation", () => {
  const failedRun = {
    id: 2,
    status: "failed",
    startedAt: new Date("2026-08-20T10:00:00Z"),
    completedAt: new Date("2026-08-20T10:01:00Z"),
    errorMessage: "HTTP 403",
  };

  it("distinguishes inactive, never-run, failing, and healthy sources", () => {
    assert.equal(deriveSourceHealth({ active: false, lastSuccessAt: null }, [failedRun]).healthState, "inactive");
    assert.equal(deriveSourceHealth({ active: true, lastSuccessAt: null }, []).healthState, "never_run");
    assert.equal(deriveSourceHealth({ active: true, lastSuccessAt: null }, [failedRun]).healthState, "failing");
    assert.equal(
      deriveSourceHealth(
        { active: true, lastSuccessAt: new Date("2026-08-19T10:00:00Z") },
        [{ ...failedRun, id: 3, status: "running", errorMessage: null, completedAt: null }],
      ).healthState,
      "healthy",
    );
  });

  it("returns the latest error and bounded recent failure detail", () => {
    const health = deriveSourceHealth(
      { active: true, lastSuccessAt: null },
      [failedRun, { ...failedRun, id: 1, errorMessage: "timeout" }],
    );
    assert.equal(health.lastError, "HTTP 403");
    assert.deepEqual(health.recentFailures.map((failure) => failure.message), ["HTTP 403", "timeout"]);
  });

  it("keeps a recent completed failure visible while a retry is running", () => {
    const running = {
      ...failedRun,
      id: 3,
      status: "running",
      completedAt: null,
      errorMessage: null,
    };
    const health = deriveSourceHealth({ active: true, lastSuccessAt: null }, [running, failedRun]);
    assert.equal(health.healthState, "failing");
    assert.equal(health.lastError, "HTTP 403");
  });
});