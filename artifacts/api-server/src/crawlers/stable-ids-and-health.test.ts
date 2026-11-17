import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stableExternalId } from "./dedup.js";
import { deriveSourceHealth } from "../lib/source-health.js";

describe("stableExternalId", () => {
  it("gives different IDs to notices whose URLs share a long prefix", () => {
    const a = stableExternalId("bah", "https://www.bahamas.gov.bs/wps/portal/public/tender-one");
    const b = stableExternalId("bah", "https://www.bahamas.gov.bs/wps/portal/public/tender-two");
    assert.notEqual(a, b);
  });

  it("gives different IDs to titles that start the same way", () => {
    const a = stableExternalId("cto", "", "Request for Proposals – Destination Marketing Agency");
    const b = stableExternalId("cto", "", "Request for Proposals – Airport Runway Resurfacing");
    assert.notEqual(a, b);
  });

  it("is stable across cosmetic URL differences", () => {
    assert.equal(
      stableExternalId("cdb", "https://www.caribank.org/work-with-us/procurement/procurement-notices/abc/"),
      stableExternalId("cdb", "https://caribank.org/work-with-us/procurement/procurement-notices/abc#files"),
    );
  });
});

describe("deriveSourceHealth empty-run warning", () => {
  const run = (id: number, itemsFound: number, status = "success") => ({
    id, status, startedAt: new Date(), completedAt: new Date(), errorMessage: null, itemsFound,
  });
  const source = { active: true, lastSuccessAt: new Date() };

  it("has no warning when the latest run listed tenders", () => {
    const health = deriveSourceHealth(source, [run(2, 4), run(1, 0)]);
    assert.equal(health.healthState, "healthy");
    assert.equal(health.healthWarning, null);
    assert.equal(health.emptyRunStreak, 0);
  });

  it("warns gently after one empty run and firmly after three", () => {
    const one = deriveSourceHealth(source, [run(3, 0), run(2, 5)]);
    assert.equal(one.healthState, "healthy");
    assert.equal(one.emptyRunStreak, 1);
    assert.match(one.healthWarning ?? "", /listed no tenders/);

    const three = deriveSourceHealth(source, [run(5, 0), run(4, 0), run(3, 0), run(2, 5)]);
    assert.equal(three.emptyRunStreak, 3);
    assert.match(three.healthWarning ?? "", /last 3 crawls/);
  });

  it("does not add a warning to a failing or inactive source", () => {
    assert.equal(deriveSourceHealth(source, [run(2, 0, "failed"), run(1, 0)]).healthWarning, null);
    assert.equal(deriveSourceHealth({ ...source, active: false }, [run(1, 0)]).healthWarning, null);
  });
});
