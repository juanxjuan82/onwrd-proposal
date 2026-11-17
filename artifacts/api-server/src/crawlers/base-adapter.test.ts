import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  stableId, parseLooseDate, extractDeadline, extractMainText, stripHtml,
} from "./base-adapter.js";

describe("stableId", () => {
  test("titles that share a long prefix get different IDs", () => {
    const a = stableId("cdb", "Request for Expressions of Interest – Consultancy for Communications Strategy");
    const b = stableId("cdb", "Request for Expressions of Interest – Consultancy for Road Design");
    assert.notEqual(a, b);
  });

  test("URLs on the same site get different IDs", () => {
    const a = stableId("bah", "https://www.bahamas.gov.bs/tenders/one", "Tender One");
    const b = stableId("bah", "https://www.bahamas.gov.bs/tenders/two", "Tender Two");
    assert.notEqual(a, b);
  });

  test("same input always gives the same ID (ignoring case/whitespace)", () => {
    assert.equal(stableId("x", " Hello "), stableId("x", "hello"));
  });
});

describe("parseLooseDate", () => {
  const ymd = (d?: Date) => d?.toISOString().slice(0, 10);
  test("UNDP style 15-Dec-26", () => assert.equal(ymd(parseLooseDate("15-Dec-26")), "2026-12-15"));
  test("UNDP style with time", () =>
    assert.equal(ymd(parseLooseDate("24-Nov-26 05:00 PM (New York time)")), "2026-11-24"));
  test("CARICOM style", () => assert.equal(ymd(parseLooseDate("February 9, 2027")), "2027-02-09"));
  test("CDB style", () => assert.equal(ymd(parseLooseDate("Dec 18, 2026 01:30 PM")), "2026-12-18"));
  test("ISO", () => assert.equal(ymd(parseLooseDate("2026-12-10T00:00:00Z")), "2026-12-10"));
  test("no date", () => assert.equal(parseLooseDate("to be confirmed"), undefined));
});

describe("extractDeadline", () => {
  test("finds the date after a deadline label, not an earlier date", () => {
    const text = "Published on 12-Nov-26. Proposals are welcome. Closing Date: November 30, 2026 at 5pm.";
    assert.equal(extractDeadline(text)?.toISOString().slice(0, 10), "2026-11-30");
  });
  test("returns undefined when no deadline is stated", () => {
    assert.equal(extractDeadline("Published 12-Nov-26. Contact the office for details."), undefined);
  });
});

describe("extractMainText", () => {
  test("keeps the article body and drops menus, scripts and footers", () => {
    const body = "The Ministry seeks a firm to deliver a communications strategy. ".repeat(6);
    const html =
      `<html><body><nav>Home About Careers</nav><script>var x=1;</script>` +
      `<main><article><h1>Notice</h1><p>${body}</p></article></main>` +
      `<footer>Copyright</footer></body></html>`;
    const text = extractMainText(html);
    assert.ok(text.includes("communications strategy"));
    assert.ok(!text.includes("Careers"));
    assert.ok(!text.includes("Copyright"));
    assert.ok(!text.includes("var x"));
  });
});

describe("stripHtml", () => {
  test("decodes accented and numeric entities", () => {
    assert.equal(stripHtml("<p>Rep&uacute;blica &amp; caf&#233;</p>"), "República & café");
  });
});
