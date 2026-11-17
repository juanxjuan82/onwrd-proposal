import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// These tests cover the paths that must hold BEFORE any database work happens:
// not configured, bad signature, and non-email events. They never reach the DB.
describe("POST /api/inbound/email (pre-database guards)", () => {
  let server: Server;
  let base = "";
  let setProvider: typeof import("./inbound-email.js").__setInboundEmailProviderForTesting;
  const saved = { key: process.env.RESEND_API_KEY, secret: process.env.RESEND_WEBHOOK_SECRET };

  before(async () => {
    process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:1/unused";
    const express = (await import("express")).default;
    const mod = await import("./inbound-email.js");
    setProvider = mod.__setInboundEmailProviderForTesting;
    const app = express();
    app.use(express.json({
      verify: (req, _res, buf) => { (req as { rawBody?: string }).rawBody = buf.toString("utf8"); },
    }));
    app.use((req, _res, next) => {
      (req as unknown as { log: Record<string, () => void> }).log =
        { info() {}, warn() {}, error() {} };
      next();
    });
    app.use("/api", mod.default);
    await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    setProvider(null);
    process.env.RESEND_API_KEY = saved.key;
    process.env.RESEND_WEBHOOK_SECRET = saved.secret;
    if (saved.key === undefined) delete process.env.RESEND_API_KEY;
    if (saved.secret === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/inbound/email`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  it("fails closed with 503 when the secrets are not configured", async () => {
    setProvider(null);
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_WEBHOOK_SECRET;
    const res = await post({ type: "email.received", data: { email_id: "em_1" } });
    assert.equal(res.status, 503);
  });

  it("rejects a delivery whose signature does not verify", async () => {
    let fetched = false;
    setProvider({
      verify() { throw new Error("bad signature"); },
      async getEmail() { fetched = true; throw new Error("must not be called"); },
      async listAttachments() { fetched = true; return []; },
    });
    const res = await post({ type: "email.received", data: { email_id: "em_1" } }, { "svix-id": "x" });
    assert.equal(res.status, 401);
    assert.equal(fetched, false, "nothing is fetched for an unverified delivery");
  });

  it("verifies against the exact raw body and signature headers", async () => {
    let seen: { raw: string; headers: Record<string, string> } | null = null;
    setProvider({
      verify(rawBody, headers) {
        seen = { raw: rawBody, headers };
        return { type: "email.sent", data: {} };
      },
      async getEmail() { throw new Error("must not be called"); },
      async listAttachments() { return []; },
    });
    const body = { type: "email.sent", data: { note: "spacing  and ünïcode must survive" } };
    const res = await post(body, { "svix-id": "msg_1", "svix-timestamp": "123", "svix-signature": "v1,abc" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ignored: true });
    assert.deepEqual(seen, {
      raw: JSON.stringify(body),
      headers: { id: "msg_1", timestamp: "123", signature: "v1,abc" },
    });
  });
});
