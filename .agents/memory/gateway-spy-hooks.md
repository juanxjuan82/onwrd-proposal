---
name: AI gateway spy hooks
description: Two test-only hooks in ai-gateway.ts that let tests control the AI path at different granularities.
---

## __setInvokeAISpy(fn | null)

**What it does:** Completely replaces `invokeAI()`. When set, the entire gateway (DB circuit check, quota reservation, OpenAI call, logging) is skipped. The spy function receives `InvokeAIParams` and must return `Promise<AIResult>`.

**When to use:** Zero-AI boundary tests, integration tests that need `invokeAI` to be a no-op or a simple counter.

```typescript
__setInvokeAISpy(async (params) => {
  callCount++;
  return { content: "mock", model: "mock" };
});
// later:
__setInvokeAISpy(null); // restore real gateway
```

**Always** call `__setInvokeAISpy(null)` in `afterEach` or `finally` to prevent state leak across tests.

---

## __setOpenAICompletionForTesting(fn | null)

**What it does:** Replaces only the `openai.chat.completions.create` call inside `callOnce()`. The full gateway logic (circuit breaker, quota reservation, DB logging, retry, error classification) still runs.

**When to use:** Circuit/retry behavior tests where you want the real quota/circuit machinery to execute but control what the "provider" returns or throws.

```typescript
__setOpenAICompletionForTesting(async () => {
  const err: any = new Error("quota exceeded");
  err.status = 402;
  err.code = "insufficient_quota";
  throw err;
});
```

Throwing with `err.status = 402` (or `err.code = "insufficient_quota"`) triggers `isQuotaError()` → `openCircuit()` in the real gateway.

Throwing with `err.status = 429` + `err.headers = { "retry-after": "0.001" }` triggers the rate-limit retry path with a 1ms delay.

**Important:** Both hooks are `null` in production — they are only settable in test code. Import them only in `*.test.ts` files.
