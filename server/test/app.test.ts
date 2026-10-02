import { expect, test } from "bun:test";
import { createPage } from "../src/services/pages";
import { seedAccount, seedDevice, testApp } from "./helpers";

test("GET /healthz reports no overdue work when idle", async () => {
  const t = testApp();
  const res = await t.app.request("/healthz");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, oldest_pending_ms: 0 });
});

test("GET /healthz reports how long the oldest due job has waited", async () => {
  const t = testApp();
  const { account } = seedAccount(t.ctx);
  seedDevice(t.ctx, account.id);
  createPage(t.ctx, { accountId: account.id, input: { title: null, message: "x", details: null, url: null, group: null }, source: "trigger", idempotencyKey: null });
  t.ctx.clock.advance(5000);
  expect(await (await t.app.request("/healthz")).json()).toEqual({ ok: true, oldest_pending_ms: 5000 });
});

test("unknown routes are JSON 404s", async () => {
  const res = await testApp().app.request("/nope");
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: { code: "not_found", message: "Not found." } });
});
