import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Crawl4AIError,
  createDomainPolicyDigest,
  createCrawl4AIClient,
  normalizeSourceApprovedDomains,
  type Crawl4AIClient,
  type Crawl4AIConfig,
  type RenderedPageResult,
} from "./crawl4ai-client.js";
import {
  extractDeadline,
  fetchApprovedText,
  fetchTenderDetailWithOptionalBrowser,
  readBoundedResponseText,
  type AdapterFetchContext,
} from "./base-adapter.js";

const config: Crawl4AIConfig = {
  endpoint: "https://crawler.internal.example/crawl",
  apiKey: "test-token",
  serverVersion: "0.7.4",
  timeoutMs: 2_000,
  maxResponseBytes: 100_000,
};

function clientWithResponse(response: Response): NonNullable<ReturnType<typeof createCrawl4AIClient>> {
  const headers = new Headers(response.headers);
  if (!headers.has("x-crawl4ai-version")) {
    headers.set("x-crawl4ai-version", config.serverVersion);
  }
  if (!headers.has("x-crawl4ai-domain-policy")) {
    headers.set("x-crawl4ai-domain-policy", createDomainPolicyDigest(["caricom.org"]));
  }
  const attestedResponse = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  return createCrawl4AIClient(
    config,
    (async () => attestedResponse) as typeof fetch,
  )!;
}

function rendered(overrides: Partial<RenderedPageResult> = {}): RenderedPageResult {
  return {
    requestedUrl: "https://caricom.org/procurement",
    finalUrl: "https://caricom.org/procurement",
    content: "CARICOM procurement listing with communications consulting opportunities and sufficient genuine page content.",
    links: [],
    metadata: {},
    diagnostics: {
      method: "crawl4ai",
      serverVersion: config.serverVersion,
      contentLength: 100,
      linkCount: 0,
    },
    ...overrides,
  };
}

describe("Crawl4AI client security boundary", () => {
  it("normalizes rendered content, links, metadata, and pinned version", async () => {
    const response = new Response(JSON.stringify({
      results: [{
        success: true,
        url: "https://caricom.org/procurement",
        markdown: "Rendered procurement content with communications campaign scope, deliverables, and submission requirements.",
        links: {
          internal: [
            { href: "/procurement/comms-rfp", text: "Communications Campaign RFP" },
            { href: "/procurement/comms-rfp", text: "Duplicate" },
            { href: "https://evil.example/redirect", text: "External link" },
          ],
        },
        metadata: { title: "CARICOM Procurement", deadline: "September 30, 2026" },
      }],
    }), {
      status: 200,
      headers: { "x-crawl4ai-version": "0.7.4" },
    });
    const result = await clientWithResponse(response).render(
      "https://caricom.org/procurement",
      ["caricom.org"],
    );

    assert.equal(result.finalUrl, "https://caricom.org/procurement");
    assert.equal(result.links.length, 1, "duplicate links must be removed");
    assert.equal(result.links[0].url, "https://caricom.org/procurement/comms-rfp");
    assert.equal(result.metadata.deadline, "September 30, 2026");
  });

  it("rejects a response without a matching version attestation", async () => {
    const response = new Response(JSON.stringify({
      success: true,
      url: "https://caricom.org/procurement",
      markdown: "Rendered procurement content with communications scope and enough genuine body content.",
    }));
    const client = createCrawl4AIClient(config, (async () => response) as typeof fetch)!;
    await assert.rejects(
      () => client.render("https://caricom.org/procurement", ["caricom.org"]),
      (error: Error) => error instanceof Crawl4AIError && error.code === "version_mismatch",
    );
  });

  it("sends the redirect/private-network policy and requires matching attestation", async () => {
    let requestBody: Record<string, unknown> | undefined;
    let requestPolicyHeader: string | null = null;
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requestPolicyHeader = new Headers(init?.headers).get("x-crawl4ai-domain-policy");
      return new Response(JSON.stringify({
        success: true,
        url: "https://caricom.org/procurement",
        markdown: "Rendered procurement content with enough detail to otherwise be accepted by the client.",
      }), {
        headers: {
          "x-crawl4ai-version": config.serverVersion,
          // Deliberately omit policy attestation: fail closed.
        },
      });
    }) as typeof fetch;
    const client = createCrawl4AIClient(config, fetchImpl)!;
    await assert.rejects(
      () => client.render("https://caricom.org/procurement", ["caricom.org"]),
      (error: Error) => error instanceof Crawl4AIError && error.code === "blocked",
    );
    assert.equal(
      requestPolicyHeader,
      createDomainPolicyDigest(["caricom.org"]),
    );
    assert.deepEqual(requestBody?.security_policy, {
      allowed_domains: ["caricom.org"],
      validate_redirects_before_request: true,
      block_private_networks: true,
      block_link_local_networks: true,
    });
  });

  it("does not allow a public suffix to be configured for a source", () => {
    assert.throws(
      () => normalizeSourceApprovedDomains("https://caricom.org/", ["org"]),
      (error: Error) => error instanceof Crawl4AIError && error.code === "invalid_config",
    );
    assert.deepEqual(
      normalizeSourceApprovedDomains("https://www.bahamas.gov.bs/", ["bahamas.gov.bs"]),
      ["bahamas.gov.bs"],
    );
  });

  it("rejects an off-domain rendered redirect", async () => {
    const response = new Response(JSON.stringify({
      success: true,
      final_url: "https://evil.example/redirected",
      markdown: "A long enough malicious page response that must never be accepted by the tender crawler.",
    }));
    await assert.rejects(
      () => clientWithResponse(response).render("https://caricom.org/procurement", ["caricom.org"]),
      (error: Error) => error instanceof Crawl4AIError && error.code === "off_domain_redirect",
    );
  });

  it("reports malformed JSON", async () => {
    await assert.rejects(
      () => clientWithResponse(new Response("{bad-json")).render(
        "https://caricom.org/procurement",
        ["caricom.org"],
      ),
      (error: Error) => error instanceof Crawl4AIError && error.code === "malformed_response",
    );
  });

  it("reports authentication failures without exposing credentials", async () => {
    await assert.rejects(
      () => clientWithResponse(new Response("Unauthorized", { status: 401 })).render(
        "https://caricom.org/procurement",
        ["caricom.org"],
      ),
      (error: Error) => {
        assert.ok(error instanceof Crawl4AIError);
        assert.equal((error as Crawl4AIError).code, "authentication");
        assert.equal(error.message.includes(config.apiKey), false);
        return true;
      },
    );
  });

  it("rejects unusable content", async () => {
    await assert.rejects(
      () => clientWithResponse(new Response(JSON.stringify({
        success: true,
        url: "https://caricom.org/procurement",
        markdown: "Too short",
      }))).render("https://caricom.org/procurement", ["caricom.org"]),
      (error: Error) => error instanceof Crawl4AIError && error.code === "unusable_content",
    );
  });

  it("classifies a timeout while streaming the response body", async () => {
    const timeoutConfig = { ...config, timeoutMs: 10 };
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener("abort", () => {
            controller.error(new DOMException("Aborted", "AbortError"));
          });
        },
      });
      return new Response(body, {
        headers: {
          "x-crawl4ai-version": timeoutConfig.serverVersion,
          "x-crawl4ai-domain-policy": createDomainPolicyDigest(["caricom.org"]),
        },
      });
    }) as typeof fetch;
    const client = createCrawl4AIClient(timeoutConfig, fetchImpl)!;
    await assert.rejects(
      () => client.render("https://caricom.org/procurement", ["caricom.org"]),
      (error: Error) => error instanceof Crawl4AIError && error.code === "timeout",
    );
  });
});

describe("approved direct fetching", () => {
  it("rejects an off-domain URL before making a network request", async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = (async () => {
      calls++;
      return new Response("must not be fetched");
    }) as typeof fetch;
    try {
      await assert.rejects(
        () => fetchApprovedText("https://evil.example/detail", ["caricom.org"], 1_000),
        /outside approved domains/i,
      );
      assert.equal(calls, 0);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("does not follow an off-domain redirect", async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = (async () => {
      calls++;
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/internal" },
      });
    }) as typeof fetch;
    try {
      await assert.rejects(
        () => fetchApprovedText("https://caricom.org/detail", ["caricom.org"], 1_000),
        /redirect target is outside approved domains/i,
      );
      assert.equal(calls, 1);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("stops reading a streamed direct response at the byte limit", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("12345"));
        controller.enqueue(new TextEncoder().encode("67890"));
        controller.close();
      },
    }));
    await assert.rejects(() => readBoundedResponseText(response, 6), /exceeds 6 bytes/i);
  });
});

describe("HTML adapter browser enrichment", () => {
  it("uses Crawl4AI fallback only after the direct detail request fails", async () => {
    const originalFetch = global.fetch;
    global.fetch = (async () => new Response("Unavailable", { status: 503 })) as typeof fetch;
    let calls = 0;
    const fakeClient: Crawl4AIClient = {
      config,
      async render(url) {
        calls++;
        return rendered({
          requestedUrl: url,
          finalUrl: url,
          content: "The selected consultancy firm will design a communications strategy, prepare public information materials, conduct stakeholder interviews, deliver a regional public awareness campaign, and submit a final implementation and impact report.",
        });
      },
    };

    try {
      const detail = await fetchTenderDetailWithOptionalBrowser(
        "https://public.example/notice/123",
        "Regional public awareness campaign",
        { crawl4ai: fakeClient, approvedDomains: ["public.example"], diagnostics: [] },
      );
      assert.equal(detail?.method, "crawl4ai");
      assert.match(detail?.content ?? "", /stakeholder interviews/i);
      assert.equal(calls, 1);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("keeps genuine direct detail without invoking browser enrichment", async () => {
    const directHtml = `<html><body><article><p>
      The selected consultancy will prepare a communications strategy, produce public information
      content, coordinate stakeholder interviews, deliver the regional campaign, meet detailed
      milestones, and provide final reporting and measurable outcomes.
    </p></article></body></html>`;
    const originalFetch = global.fetch;
    global.fetch = (async () => new Response(directHtml, {
      headers: { "content-type": "text/html" },
    })) as typeof fetch;
    const diagnostics: NonNullable<AdapterFetchContext["diagnostics"]> = [];
    let calls = 0;
    const fakeClient: Crawl4AIClient = {
      config,
      async render(url) {
        calls++;
        throw new Crawl4AIError("service_unavailable", "service offline", url);
      },
    };

    try {
      const detail = await fetchTenderDetailWithOptionalBrowser(
        "https://public.example/notice/123",
        "Regional communications campaign",
        {
        crawl4ai: fakeClient,
        approvedDomains: ["public.example"],
        diagnostics,
        },
      );
      assert.equal(detail?.method, "direct");
      assert.match(detail?.content ?? "", /detailed\s+milestones/i);
      assert.equal(calls, 0);
      assert.equal(
        diagnostics.some((item) => item.code === "crawl4ai_service_unavailable"),
        false,
        "a usable direct detail must not invoke Crawl4AI",
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("preserves an expired deadline from real detail text", async () => {
    const directHtml = `<html><body><article>
      The selected firm will develop a public communications strategy, coordinate stakeholder
      interviews, deliver campaign materials, manage community outreach, and report final results.
      Deadline: January 1, 2020.
    </article></body></html>`;
    const originalFetch = global.fetch;
    global.fetch = (async () => new Response(directHtml, {
      headers: { "content-type": "text/html" },
    })) as typeof fetch;

    try {
      const detail = await fetchTenderDetailWithOptionalBrowser(
        "https://public.example/notice/expired",
        "Regional communications procurement",
        { approvedDomains: ["public.example"] },
      );
      assert.equal(extractDeadline(detail?.content ?? "")?.getFullYear(), 2020);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("contains no AI gateway or model invocation in the crawler integration", async () => {
    const fs = await import("node:fs/promises");
    const files = ["./crawl4ai-client.ts", "./base-adapter.ts", "./bahamas-gov.ts", "./caricom.ts"];
    const source = (await Promise.all(files.map((file) =>
      fs.readFile(new URL(file, import.meta.url), "utf8"),
    ))).join("\n");
    assert.doesNotMatch(source, /\binvokeAI\b|\bOpenAI\b|\bAnthropic\b|\bGemini\b|llm_strategy/i);
  });
});