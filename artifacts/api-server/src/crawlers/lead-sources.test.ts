import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EmailAlertAdapter,
  isAllowedSender,
  parseAlertEmail,
  readAllowedSenders,
} from "./email-alerts.js";
import { parseCsv, selectCanadaBuysNotices } from "./canadabuys.js";
import { getListingSource, parseListingPage } from "./listing-adapter.js";

process.env.DATABASE_URL ??= "postgres://x:x@localhost/x";

describe("alert emails — who may send them", () => {
  it("accepts built-in tender platforms and configured senders only", () => {
    const allowed = readAllowedSenders("me@onwrd.example, partner.org");
    assert.ok(isAllowedSender("UNGM <noreply@ungm.org>", allowed));
    assert.ok(isAllowedSender("alerts@notifications.bonfirehub.com", allowed));
    assert.ok(isAllowedSender("Me <me@onwrd.example>", allowed));
    assert.ok(isAllowedSender("someone@mail.partner.org", allowed));
    assert.ok(!isAllowedSender("other@onwrd.example", allowed));
    assert.ok(!isAllowedSender("phish@ungm.org.evil.example", allowed));
    assert.ok(!isAllowedSender("not-an-address", allowed));
  });
});

describe("alert emails — reading leads out of an email", () => {
  const html = `<html><head><style>a{color:red}</style></head><body>
    <p>New notices matching your profile:</p>
    <table>
      <tr><td><a href="https://www.ungm.org/Public/Notice/271234">Communication Strategy and Public Awareness Campaign for Coastal Resilience, Jamaica</a>
        <br>UNDP Jamaica &middot; Request for proposal &middot; Deadline: 14 December 2026<br>
        The firm will design and deliver a communication strategy, media relations and a public awareness campaign across three parishes.</td></tr>
      <tr><td><a href="https://www.ungm.org/Public/Notice/271235">Supply of Laboratory Reagents for the Ministry of Health</a>
        <br>PAHO Barbados &middot; Invitation to bid &middot; Deadline: 02 January 2027</td></tr>
    </table>
    <p><a href="https://www.ungm.org/Account/Unsubscribe?u=1">Unsubscribe from these alerts</a> |
       <a href="https://www.ungm.org/">Visit the website</a> | <a href="javascript:alert(1)">A very long link text that is not safe</a></p>
  </body></html>`;

  it("makes one lead per tender link, each with its own text and deadline", () => {
    const leads = parseAlertEmail({ id: "e1", from: "UNGM <noreply@ungm.org>", subject: "Tender alert", html });
    assert.deepEqual(leads.map((lead) => lead.url), [
      "https://www.ungm.org/Public/Notice/271234",
      "https://www.ungm.org/Public/Notice/271235",
    ]);
    assert.match(leads[0].title, /^Communication Strategy and Public Awareness Campaign/);
    assert.equal(leads[0].deadline?.toISOString().slice(0, 10), "2026-12-14");
    assert.match(leads[0].context, /media relations and a public awareness campaign/);
    assert.ok(!leads[0].context.includes("Laboratory Reagents"));
    assert.equal(leads[1].deadline?.toISOString().slice(0, 10), "2027-01-02");
  });

  it("reads plain-text alerts: a title line followed by its link", () => {
    const leads = parseAlertEmail({
      id: "e2", from: "alerts@bonfirehub.com", subject: "New opportunity",
      text: "A new opportunity has been posted.\n\nPublic Relations Services for UK and Europe\nhttps://cayman.bonfirehub.com/opportunities/12345\nClose Date: 9 January 2027\n\nManage notifications: https://cayman.bonfirehub.com/settings",
    });
    assert.equal(leads.length, 1);
    assert.equal(leads[0].title, "Public Relations Services for UK and Europe");
    assert.equal(leads[0].url, "https://cayman.bonfirehub.com/opportunities/12345");
    assert.equal(leads[0].deadline?.toISOString().slice(0, 10), "2027-01-09");
  });

  it("falls back to one lead from the subject when the email has no tender links", () => {
    const leads = parseAlertEmail({
      id: "e3", from: "me@onwrd.example", subject: "Fwd: RE: RFP - Destination Marketing Agency of Record",
      text: "The Tourism Authority invites proposals from marketing agencies to serve as agency of record. Proposals are due by 20 January 2027.",
    });
    assert.equal(leads.length, 1);
    assert.equal(leads[0].title, "RFP - Destination Marketing Agency of Record");
    assert.equal(leads[0].url, undefined);
  });
});

describe("alert emails — adapter", () => {
  it("ignores unapproved senders and expired tenders, and never fetches links", async () => {
    const originalFetch = globalThis.fetch;
    let fetched = 0;
    globalThis.fetch = (async () => { fetched++; return new Response("", { status: 500 }); }) as typeof fetch;
    try {
      const future = "Deadline: 14 December 2099";
      const adapter = new EmailAlertAdapter(async () => [
        { id: "a", from: "UNGM <noreply@ungm.org>", subject: "Alert",
          html: `<a href="https://www.ungm.org/Public/Notice/1">Public Relations and Media Relations Services for Tourism</a> ${future}. The agency will deliver a communications strategy, media relations and a destination marketing campaign for the ministry over twelve months.` },
        { id: "b", from: "UNGM <noreply@ungm.org>", subject: "Alert",
          html: `<a href="https://www.ungm.org/Public/Notice/2">An Old Tender That Closed Years Ago</a> Deadline: 14 December 2020` },
        { id: "c", from: "Stranger <x@unknown.example>", subject: "Alert",
          html: `<a href="https://unknown.example/1">Marketing Agency Services Tender</a> ${future}` },
      ]);
      const diagnostics: Array<{ message: string }> = [];
      const results = await adapter.fetchOpportunities({ diagnostics: diagnostics as never });
      assert.deepEqual(results.map((item) => item.url), ["https://www.ungm.org/Public/Notice/1"]);
      assert.equal(results[0].organization, "UNGM (email alert)");
      assert.match(results[0].externalId ?? "", /^alert-/);
      assert.match(diagnostics[0].message, /Read 2 alert emails and found 1 leads; skipped 1 expired; ignored 1 from unapproved senders/);
      assert.equal(fetched, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("CanadaBuys — open-data file", () => {
  const header = "title-titre-eng,referenceNumber-numeroReference,tenderClosingDate-appelOffresDateCloture,tenderStatus-appelOffresStatut-eng,noticeType-avisType-eng,contractingEntityName-nomEntitContractante-eng,noticeURL-URLavis-eng,tenderDescription-descriptionAppelOffres-eng,unspscDescription-eng";
  const now = new Date("2026-11-21T00:00:00Z");

  it("parses quoted fields with commas and line breaks", () => {
    assert.deepEqual(parseCsv("﻿a,b\r\n\"x, y\",\"line1\nline2 \"\"q\"\"\"\n"), [["a", "b"], ["x, y", "line1\nline2 \"q\""]]);
  });

  it("keeps open marketing notices and drops the rest", () => {
    const csv = [
      header,
      "Marketing Media Agency Services,cb-1,2026-12-20T14:00:00,Open,Request for Proposal,VIA Rail Canada Inc.,https://www.merx.com/x,\"Agency of record for media buying, creative and social media.\",*Advertising",
      "Marketing Media Agency Services (old),cb-2,2026-10-05T14:00:00,Open,Request for Proposal,VIA Rail,,Closed already,",
      "Supply of Road Salt,cb-3,2026-12-20T14:00:00,Open,Request for Proposal,Transport Canada,,Salt,",
      "Advertising Services,cb-4,2026-12-20T14:00:00,Cancelled,Request for Proposal,Health Canada,,Ads,",
      "Public Relations Services,cb-5,2026-12-22T14:00:00,Open,Request for Proposal,Destination Canada,,PR services,",
    ].join("\n");
    const results = selectCanadaBuysNotices(csv, now);
    assert.deepEqual(results.map((item) => item.externalId), ["canadabuys-cb-1", "canadabuys-cb-5"]);
    assert.equal(results[0].country, "Canada");
    assert.equal(results[0].url, "https://www.merx.com/x");
    assert.match(results[1].url ?? "", /^https:\/\/canadabuys\.canada\.ca\/en\/tender-opportunities\/tender-notice\/cb-5$/);
    assert.match(results[0].description, /media buying, creative and social media/);
  });
});

describe("O'Dwyer's RFP list — US dates", () => {
  it("reads month/day/year dates the US way and takes the story link", () => {
    const config = getListingSource("odwyers_rfps");
    assert.ok(config);
    const html = `<tr style="background-color:#ffffff"> <td class="rfps-list-tablecell"><div align=center><a href="/story/public/25645/2026-11-20/fort-collins-seeks-pr.html" target=_blank><img src="x.webp" alt="Fort Collins Seeks PR"></a></div></td>
      <td class="rfps-list-tablecell data-hide-mobile"><a href="/story/public/25645/2026-11-20/fort-collins-seeks-pr.html" target=_blank>Fort Collins Seeks PR for Capital Projects</a></td>
      <td class="rfps-list-tablecell">Government</td><td class="rfps-list-tablecell data-hide-mobile">CO</td>
      <td class="rfps-list-tablecell"><div class="data-display-mobile">Posted:<BR></div>11/20/2026<div class="data-display-mobile">Due:<BR>12/11/2026</div></td>
      <td class="rfps-list-tablecell data-hide-mobile">12/11/2026</td> </tr>
      <!--<tr class="rfps-description-row-display-mobile"> <td colspan="4"><B>Description:</b> Fort Collins, CO seeks a firm to handle PR and communications support services.</td> </tr>-->`;
    const rows = parseListingPage(html, "https://www.odwyerpr.com/rfps/", config);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, "Fort Collins Seeks PR for Capital Projects");
    assert.equal(rows[0].url, "https://www.odwyerpr.com/story/public/25645/2026-11-20/fort-collins-seeks-pr.html");
    assert.equal(rows[0].deadline?.toISOString().slice(0, 10), "2026-12-11");
    assert.equal(rows[0].postedAt?.toISOString().slice(0, 10), "2026-11-20");
    assert.match(rows[0].summary, /communications support services/);
    assert.ok(!rows[0].summary.includes("-->"));
  });
});

describe("scoring — leads outside the Caribbean", () => {
  const scope = "The tourism office seeks a public relations and destination marketing agency of record to deliver a media relations programme, social media content and an advertising campaign. Scope of work and deliverables are set out in the RFP.";
  const deadline = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  it("scores a US lead instead of skipping it, and flags it", async () => {
    const { scoreCrawlerOpportunity } = await import("./index.js");
    const us = scoreCrawlerOpportunity({ title: "Travel Oregon Wants PR Partner", organization: "Travel Oregon", description: scope, country: "United States", deadline });
    assert.notEqual(us.recommendation, "SKIP");
    assert.equal(us.geoRegion, "north_america");
    assert.match(us.reasoning, /Outside the Caribbean/);
  });

  it("keeps Caribbean leads ahead and unflagged", async () => {
    const { scoreCrawlerOpportunity } = await import("./index.js");
    const us = scoreCrawlerOpportunity({ title: "Tourism PR Partner", organization: "Tourism Office", description: scope, country: "United States", deadline });
    const bahamas = scoreCrawlerOpportunity({ title: "Tourism PR Partner", organization: "Tourism Office", description: scope, country: "Bahamas", deadline });
    assert.ok(bahamas.fitScore > us.fitScore);
    assert.equal(bahamas.geoRegion, "bahamas");
    assert.ok(!/Outside the Caribbean/.test(bahamas.reasoning));
  });
});
