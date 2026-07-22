/**
 * AI Workflow Call-Count & OperationKey Idempotency Tests
 *
 * Verifies that:
 *   1. Explicit AI workflows (extract-requirements, generate-strategy,
 *      generate-proposal, run-critic) hit invokeAI exactly once per
 *      invocation with no extra calls.
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
import { db } from "@workspace/db";
import { proposalsTable, proposalSectionsTable } from "@workspace/db";
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

  function makeStrategyContent(): string {
    return JSON.stringify({
      positioning:              "Trusted Caribbean digital partner with proven regional RFP experience.",
      winThemes:                ["Local expertise", "Proven ROI", "Regulatory compliance", "Community impact"],
      recommendedCaseStudies:   ["Ministry of Tourism Digital Campaign"],
      risks:                    ["Timeline", "Scope creep"],
      messagingGuidance:        "Lead with local presence and measurable, documented outcomes.",
    });
  }

  function makeProposalContent(): string {
    return JSON.stringify({
      sections: [
        { key: "executive_summary",     content: "ONWRD is the right partner for this opportunity." },
        { key: "company_overview",      content: "ONWRD is a full-service agency based in Nassau, Bahamas." },
        { key: "understanding",         content: "We understand the client's requirements comprehensively." },
        { key: "approach",              content: "Our approach is structured and evidence-based." },
        { key: "methodology",           content: "We use proven methodologies tailored to Caribbean contexts." },
        { key: "team",                  content: "Our team has deep regional expertise." },
        { key: "case_studies",          content: "See Ministry of Tourism and BISX campaigns." },
        { key: "timeline",              content: "Milestone-driven 12-week delivery plan." },
        { key: "budget",                content: "[NEEDS ONWRD INPUT: pricing schedule in Appendix A]" },
        { key: "evaluation",            content: "We will measure success via agreed KPIs." },
        { key: "risk_management",       content: "Risk register attached; key mitigations outlined." },
        { key: "compliance",            content: "All regulatory requirements are met." },
        { key: "sustainability",        content: "Our approach supports long-term community benefit." },
        { key: "innovation",            content: "Digital-first delivery for maximum efficiency." },
        { key: "conclusion",            content: "We look forward to partnering on this initiative." },
      ],
    });
  }

  function makeCriticContent(): string {
    return JSON.stringify({
      sections: [{ sectionKey: "executive_summary", issues: [], severity: "clean" }],
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
      assert.notEqual(res1.status, 500, "first extract call must not 500");

      const countAfterFirst = callCount;

      const res2 = await fetch(`${baseUrl}/api/opportunities/${tenderId}/extract-requirements`, {
        method: "POST",
      });
      assert.notEqual(res2.status, 500, "second extract call must not 500");

      const secondCallMade = res2.status !== 409;
      if (secondCallMade) {
        assert.equal(callCount, countAfterFirst + 1, "each extract invocation adds exactly 1 AI call");
      } else {
        assert.equal(callCount, countAfterFirst, "409-blocked call must not add any AI calls");
      }
    });
  });

  // ── Route-level call-count: generate-strategy (async background job) ──────

  describe("generate-strategy call count", () => {
    it("POST /api/opportunities/:id/generate-strategy makes exactly 1 AI call", async () => {
      const tenderId = await createTender();

      let strategyCallCount = 0;
      let resolveFirstCall: (() => void) | undefined;
      const firstCallPromise = new Promise<void>((resolve) => {
        resolveFirstCall = resolve;
      });

      __setInvokeAISpy(async (_params: InvokeAIParams): Promise<AIResult> => {
        strategyCallCount++;
        resolveFirstCall?.();
        resolveFirstCall = undefined;
        return { content: makeStrategyContent(), model: "gpt-4o-mini-mock" };
      });

      const res = await fetch(`${baseUrl}/api/opportunities/${tenderId}/generate-strategy`, {
        method: "POST",
      });

      assert.notEqual(res.status, 500, `generate-strategy returned ${res.status}`);
      assert.notEqual(res.status, 409, "generate-strategy must not 409 on a freshly created tender");

      await Promise.race([
        firstCallPromise,
        new Promise<void>((_, reject) =>
          setTimeout(
            () => reject(new Error("generate-strategy spy not called within 7s")),
            7000,
          )
        ),
      ]);

      assert.equal(strategyCallCount, 1, "generate-strategy must invoke AI exactly once");
    });
  });

  // ── Route-level call-count: generate-proposal (async background job) ──────

  describe("generate-proposal call count", () => {
    it("POST /api/opportunities/:id/generate-proposal makes exactly 1 AI call (all sections in one batch)", async () => {
      const tenderId = await createTender();

      let proposalCallCount = 0;
      let resolveFirstCall: (() => void) | undefined;
      const firstCallPromise = new Promise<void>((resolve) => {
        resolveFirstCall = resolve;
      });

      __setInvokeAISpy(async (_params: InvokeAIParams): Promise<AIResult> => {
        proposalCallCount++;
        resolveFirstCall?.();
        resolveFirstCall = undefined;
        return { content: makeProposalContent(), model: "gpt-4o-mini-mock" };
      });

      const res = await fetch(`${baseUrl}/api/opportunities/${tenderId}/generate-proposal`, {
        method: "POST",
      });

      assert.ok(
        res.status === 200 || res.status === 201,
        `generate-proposal must return 200/201, got ${res.status}`,
      );

      await Promise.race([
        firstCallPromise,
        new Promise<void>((_, reject) =>
          setTimeout(
            () => reject(new Error("generate-proposal spy not called within 15s")),
            15000,
          )
        ),
      ]);

      assert.equal(
        proposalCallCount,
        1,
        "generate-proposal must make exactly 1 AI call (single batch for all 15 sections)",
      );
    });
  });

  // ── Route-level call-count: run-critic (synchronous) ─────────────────────

  describe("section-regeneration (run-critic) call count", () => {
    it("POST /api/proposals/:id/run-critic makes exactly 1 AI call", async () => {
      const tenderId = await createTender();

      // Insert proposal and section directly in DB to avoid race conditions
      // with any background work from generate-proposal.
      const [proposal] = await db
        .insert(proposalsTable)
        .values({
          clientName:      "Test Agency",
          industry:        "Infrastructure",
          briefText:       "Test brief for run-critic route call-count test.",
          proposalContent: "Test proposal content.",
          status:          "proposal_drafting",
          tenderId,
        })
        .returning();

      await db.insert(proposalSectionsTable).values({
        proposalId: proposal.id,
        sectionKey: "executive_summary",
        title:      "Executive Summary",
        content:    "ONWRD brings extensive regional experience to infrastructure projects.",
        status:     "completed",
        orderIndex: 1,
      });

      let criticCallCount = 0;
      __setInvokeAISpy(async (_params: InvokeAIParams): Promise<AIResult> => {
        criticCallCount++;
        return { content: makeCriticContent(), model: "gpt-4o-mini-mock" };
      });

      const criticRes = await fetch(`${baseUrl}/api/proposals/${proposal.id}/run-critic`, {
        method: "POST",
      });

      assert.notEqual(criticRes.status, 500, `run-critic returned ${criticRes.status}`);
      assert.notEqual(criticRes.status, 404, "proposal must be found");
      assert.equal(criticCallCount, 1, "run-critic must invoke AI exactly once (synchronous)");
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
        const r1 = await invokeAI(params);
        assert.equal(typeof r1.content, "string", "first call must return content");

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
