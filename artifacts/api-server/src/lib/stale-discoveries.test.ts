import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { staleDiscoveryReason } from "./stale-discoveries.js";

const now = new Date("2026-11-20T12:00:00Z");
const cdn = "https://cdn.bahamas.gov.bs/tenant/tenanttgotb/documents/All Documents";

describe("staleDiscoveryReason", () => {
  it("flags any discovery whose deadline has passed", () => {
    assert.equal(staleDiscoveryReason({
      adapterType: "world_bank", title: "Communication strategy", url: "https://projects.worldbank.org/x",
      deadline: "2026-10-01T00:00:00Z",
    }, now), "expired");
  });

  it("keeps live and undated notices from other sources", () => {
    assert.equal(staleDiscoveryReason({
      adapterType: "world_bank", title: "Communication strategy", url: "https://projects.worldbank.org/x",
      deadline: "2026-12-15T00:00:00Z",
    }, now), null);
    assert.equal(staleDiscoveryReason({
      adapterType: "caricom", title: "Awareness campaign", url: "https://caricom.org/procurement/x", deadline: null,
    }, now), null);
  });

  it("flags Bahamas archive rows, navigation links and external portals", () => {
    const check = (title: string, url: string | null) =>
      staleDiscoveryReason({ adapterType: "bahamas_gov", title, url, deadline: null }, now);
    assert.equal(check("Marketing & Communications Plan and Strategy - BBSQ", `${cdn}/MktingCommsTOR-20240110162109.pdf`), "stale_undated");
    assert.equal(check("Government of The Commonwealth of The Bahamas", "https://www.bahamas.gov.bs"), "navigation_link");
    assert.equal(check("Invitation for Potential Bidders", "https://www.un.org/Depts/ptd/eoi"), "external_link");
    assert.equal(check("Tourism Marketing Campaign RFP", `${cdn}/Tourism-RFP-20261101101010.pdf`), null);
  });
});
