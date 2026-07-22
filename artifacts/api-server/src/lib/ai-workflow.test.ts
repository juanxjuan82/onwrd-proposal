/**
 * AI Workflow Call-Count & OperationKey Idempotency Tests
 *
 * Verifies that:
 *   1. Explicit AI workflows (e.g. extract-requirements) hit invokeAI exactly
 *      once per invocation with no extra calls.
 *   2. The operationKey mechanism (AI_MAX_CALLS_PER_OPERATION) prevents
 *      duplicate invocations within a day.
 *   3. Different operationKeys don't interfere with each other.
 *
 * Runner: node:test
 * Transpiler: tsx (ESM)
 * Requires: live PostgreSQL + Express server on port 0
 *
 * All hooks are inside the top-level describe for correct isolation when
 * node:test runs multiple test files in the same process.
 */

import http from "node:http";
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import app from "../app.js";
import {
  invokeAI,
  GatewayLimitError,
  __setInvokeAISpy,
  __setOpenAICompletionForTesting,
  type InvokeAIParams,
  type AIResult,
} from "./ai-gateway.js";

describe("ai-workflow: call-count and operationKey idempotency", () => {
  let server: http.Server;
  let baseUrl: string;

  before(
    () =>
      new Promise<void>((resolve) => {
        server = http.createServer(app as any);
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address() as { port: number };
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        });
      }),
  );

  after(
    () =>
      new Promise<void>((resolve, reject) => {
        __setInvokeAISpy(null);
        __setOpenAICompletionForTesting(null);
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  );

  afterEach(() => {
    __setInvokeAISpy(null);
    __setOpenAICompletionForTesting(null);
  });

  // ── Helpers ──────────────────────────────────────────────────────────────────

  async function createTender(): Promise<number> {
    const res = await fetch(`${baseUrl}/api/opportunities`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        title:       `Call-Count Test Tender ${Date.now()}`,
        agency:      "Test Agency",
        description:
          "This is a test tender with enough text for the AI extraction endpoint. " +
          "It describes road infrastructure services including civil engineering, " +
          "ISO certification, public liability insurance, and mobilisation timelines.",
        rawText:
          "TENDER NOTICE — Call-Count Test\n\n" +
          "Scope of Works: Provide civil engineering and road maintenance services " +
          "for a period of two years. Mandatory requirements: ISO 9001 certification, " +
          "public liability insurance of $10 million, response within 48 hours of award. " +
          "Submissions due by 1 September 2026. Include pricing schedule in Appendix A.",
      }),
    });
    assert.ok(res.status < 300, `createTender failed with status ${res.status}`);
    const body = (await res.json()) as { id: number };
    assert.ok(typeof body.id === "number", "createTender must return an object with numeric id");
    return body.id;
  }

  function makeRequirementsContent(): string {
    return JSON.stringify({
      requirements: [
        { requirementText: "ISO 9001 certification required",         category: "certifications", isMandatory: true },
        { requirementText: "Public liability insurance of $10M min",  category: "compliance",     isMandatory: true },
        { requirementText: "Mobilise within 48 hours of award",       category: "timeline",       isMandatory: true },
      ],
    });
  }

  // ── Route-level call-count: extract-requirements ──────────────────────────

  describe("extract-requirements call count", () => {
    it("POST /api/opportunities/:id/extract-requirements makes exactly 1 AI call", async () => {
      const tenderId = await createTender();

      let callCount = 0;
      __setInvokeAISpy(async (_params: InvokeAIParams): Promise<AIResult> => {
        callCount++;
        return {
          content: makeRequirementsContent(),
          model:   "gpt-4o-mini-mock",
        };
      });

      const res = await fetch(`${baseUrl}/api/opportunities/${tenderId}/extract-requirements`, {
        method: "POST",
      });

      assert.notEqual(res.status, 500, `extract-requirements returned 500; spy calls: ${callCount}`);
      assert.equal(callCount, 1, "extract-requirements must invoke AI exactly once per call");
    });

    it("calling extract-requirements twice on the same tender makes 2 AI calls total", async () => {
      const tenderId = await createTender();

      let callCount = 0;
      __setInvokeAISpy(async (_params: InvokeAIParams): Promise<AIResult> => {
        callCount++;
        return { content: makeRequirementsContent(), model: "gpt-4o-mini-mock" };
      });

      const res1 = await fetch(`${baseUrl}/api/opportunities/${tenderId}/extract-requirements`, {
        method: "POST",
      });
      // Allow 200 or 409 (already active) — both are acceptable non-500 results.
      assert.notEqual(res1.status, 500, "first extract call must not 500");

      const countAfterFirst = callCount;

      const res2 = await fetch(`${baseUrl}/api/opportunities/${tenderId}/extract-requirements`, {
        method: "POST",
      });
      assert.notEqual(res2.status, 500, "second extract call must not 500");

      // Each non-blocked call incurs exactly 1 AI call.
      const secondCallMade = res2.status !== 409;
      if (secondCallMade) {
        assert.equal(callCount, countAfterFirst + 1, "each extract invocation adds exactly 1 AI call");
      } else {
        assert.equal(callCount, countAfterFirst, "409-blocked call must not add any AI calls");
      }
    });
  });

  // ── OperationKey idempotency ──────────────────────────────────────────────

  describe("operationKey idempotency", () => {
    it("second call with same operationKey is blocked when AI_MAX_CALLS_PER_OPERATION=1", async () => {
      const savedLimit = process.env.AI_MAX_CALLS_PER_OPERATION;
      process.env.AI_MAX_CALLS_PER_OPERATION = "1";

      __setOpenAICompletionForTesting(async () => ({
        choices: [{ message: { content: "idempotency-ok" } }],
        model:   "gpt-4o-mini",
        usage:   { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      }));

      const opKey  = `test-idempotency-${Date.now()}`;
      const params: InvokeAIParams = {
        feature:      "section_regeneration",
        messages:     [{ role: "user", content: "idempotency test prompt" }],
        maxTokens:    10,
        operationKey: opKey,
      };

      try {
        // First call must succeed.
        const r1 = await invokeAI(params);
        assert.equal(typeof r1.content, "string", "first call must return content");

        // Second call with same operationKey must be blocked.
        let secondErr: unknown;
        try {
          await invokeAI({ ...params, messages: [{ role: "user", content: "duplicate call" }] });
        } catch (err) {
          secondErr = err;
        }

        assert.ok(
          secondErr instanceof GatewayLimitError,
          `second call with same operationKey must throw GatewayLimitError, got: ${secondErr}`,
        );
      } finally {
        const env = process.env as Record<string, string | undefined>;
        if (savedLimit !== undefined) env.AI_MAX_CALLS_PER_OPERATION = savedLimit;
        else delete env.AI_MAX_CALLS_PER_OPERATION;
        __setOpenAICompletionForTesting(null);
      }
    });

    it("different operationKeys do not interfere with each other", async () => {
      const savedLimit = process.env.AI_MAX_CALLS_PER_OPERATION;
      process.env.AI_MAX_CALLS_PER_OPERATION = "1";

      __setOpenAICompletionForTesting(async () => ({
        choices: [{ message: { content: "distinct-key-ok" } }],
        model:   "gpt-4o-mini",
        usage:   { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      }));

      const ts = Date.now();
      try {
        const r1 = await invokeAI({
          feature:      "section_regeneration",
          messages:     [{ role: "user", content: "key A" }],
          maxTokens:    10,
          operationKey: `opkey-A-${ts}`,
        });
        const r2 = await invokeAI({
          feature:      "section_regeneration",
          messages:     [{ role: "user", content: "key B" }],
          maxTokens:    10,
          operationKey: `opkey-B-${ts}`,
        });

        assert.equal(typeof r1.content, "string", "call with opkey-A must succeed");
        assert.equal(typeof r2.content, "string", "call with opkey-B must succeed independently");
      } finally {
        const env = process.env as Record<string, string | undefined>;
        if (savedLimit !== undefined) env.AI_MAX_CALLS_PER_OPERATION = savedLimit;
        else delete env.AI_MAX_CALLS_PER_OPERATION;
        __setOpenAICompletionForTesting(null);
      }
    });

    it("operationKey limit is per-key, not per-feature", async () => {
      const savedLimit = process.env.AI_MAX_CALLS_PER_OPERATION;
      process.env.AI_MAX_CALLS_PER_OPERATION = "1";

      __setOpenAICompletionForTesting(async () => ({
        choices: [{ message: { content: "per-key-ok" } }],
        model:   "gpt-4o-mini",
        usage:   { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      }));

      const ts = Date.now();
      const key1 = `per-key-${ts}-1`;
      const key2 = `per-key-${ts}-2`;

      try {
        // Both calls use the same feature but different operationKeys — both must succeed.
        const [r1, r2] = await Promise.all([
          invokeAI({
            feature:      "requirements_extraction",
            messages:     [{ role: "user", content: "key-1 call" }],
            maxTokens:    10,
            operationKey: key1,
          }),
          invokeAI({
            feature:      "requirements_extraction",
            messages:     [{ role: "user", content: "key-2 call" }],
            maxTokens:    10,
            operationKey: key2,
          }),
        ]);

        assert.equal(typeof r1.content, "string", "key-1 call must succeed");
        assert.equal(typeof r2.content, "string", "key-2 call must succeed");
      } finally {
        const env = process.env as Record<string, string | undefined>;
        if (savedLimit !== undefined) env.AI_MAX_CALLS_PER_OPERATION = savedLimit;
        else delete env.AI_MAX_CALLS_PER_OPERATION;
        __setOpenAICompletionForTesting(null);
      }
    });
  });
});
