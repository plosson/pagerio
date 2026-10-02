import { expect, test } from "bun:test";
import { createApp } from "../src/app";

test("GET /healthz answers ok", async () => {
  const res = await createApp().request("/healthz");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test("unknown routes are 404", async () => {
  const res = await createApp().request("/nope");
  expect(res.status).toBe(404);
});
