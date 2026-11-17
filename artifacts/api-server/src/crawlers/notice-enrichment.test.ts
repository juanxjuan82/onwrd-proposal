import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveNoticeUrl, fetchNoticeDetail } from "./base-adapter.js";

test("resolves nested relative paths against their source page", () => {
  assert.equal(
    resolveNoticeUrl("../notice/123?x=1&amp;y=2", "https://caricom.org/procurement-notices/2026/"),
    "https://caricom.org/procurement-notices/notice/123?x=1&y=2",
  );
});

test("rejects external notice URLs and unsupported schemes", () => {
  assert.equal(resolveNoticeUrl("https://external.example/notice", "https://caricom.org/"), null);
  assert.equal(resolveNoticeUrl("javascript:alert(1)", "https://caricom.org/"), null);
});

test("rejects a notice with no substantive text", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("<html><main>Short</main></html>", {
    headers: { "content-type": "text/html" },
  });
  try {
    assert.equal(await fetchNoticeDetail("https://caricom.org/notice/123"), null);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("returns substantive main content from a fetched notice", async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    "<html><body><nav>Navigation</nav><main><h1>Consultancy</h1><p>" +
    "The selected firm will deliver stakeholder engagement strategy, interview planning, public consultations, " +
    "social research and a comprehensive communications programme for regional development partners." +
    "</p></main></body></html>",
    { headers: { "content-type": "text/html" } },
  );
  try {
    const description = await fetchNoticeDetail("https://caricom.org/notice/123");
    assert.match(description ?? "", /stakeholder engagement strategy/);
    assert.doesNotMatch(description ?? "", /Navigation/);
  } finally {
    globalThis.fetch = oldFetch;
  }
});
