import { describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { listDevicesForAccount } from "../../src/db/devices";
import { getAccountByGoogleSub } from "../../src/db/accounts";
import { createSession } from "../../src/services/sessions";
import { createPage } from "../../src/services/pages";
import { seedAccount, testApp, testConfig } from "../helpers";

const TOKEN = "c3".repeat(32);

async function signIn(app: Hono, idToken = "google:sub-1:a@example.com"): Promise<string> {
  const res = await app.request("/api/auth/google", { method: "POST", body: JSON.stringify({ id_token: idToken }), headers: { "content-type": "application/json" } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { session_token: string }).session_token;
}

const authed = (token: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers as Record<string, string>) },
});

function addPage(t: ReturnType<typeof testApp>, accountId: string, message: string) {
  const r = createPage(t.ctx, { accountId, input: { title: null, message, details: null, url: null, group: null }, source: "trigger", idempotencyKey: null });
  if (!r.ok) throw new Error("rate limited");
  return r.page;
}

describe("POST /api/auth/google", () => {
  test("creates the account on first sign-in and reuses it after", async () => {
    const t = testApp();
    const first = await signIn(t.app);
    const second = await signIn(t.app);
    expect(first).not.toBe(second);
    expect(getAccountByGoogleSub(t.ctx.db, "sub-1")?.email).toBe("a@example.com");
    expect(t.ctx.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM accounts").get()!.n).toBe(1);
  });

  test("returns the email with the session", async () => {
    const t = testApp();
    const res = await t.app.request("/api/auth/google", { method: "POST", body: JSON.stringify({ id_token: "google:s:me@example.com" }) });
    expect(((await res.json()) as { email: string }).email).toBe("me@example.com");
  });

  test("an unverifiable Google token is 401", async () => {
    const res = await testApp().app.request("/api/auth/google", { method: "POST", body: JSON.stringify({ id_token: "forged" }) });
    expect(res.status).toBe(401);
  });

  for (const [name, body] of [
    ["no body", undefined],
    ["non-JSON", "id_token=abc"],
    ["a numeric token", JSON.stringify({ id_token: 5 })],
    ["an empty token", JSON.stringify({ id_token: "" })],
    ["a JSON array", "[]"],
  ] as const) {
    test(`${name} is 400`, async () => {
      const res = await testApp().app.request("/api/auth/google", { method: "POST", body });
      expect(res.status).toBe(400);
    });
  }
});

describe("bearer authentication", () => {
  test("missing, malformed and unknown tokens are 401", async () => {
    const t = testApp();
    for (const header of [undefined, "Bearer", "Basic abc", `Bearer ${"z".repeat(43)}`]) {
      const res = await t.app.request("/api/pages", { headers: header ? { authorization: header } : {} });
      expect(res.status).toBe(401);
    }
  });

  test("a web session token cannot be used as a bearer token", async () => {
    const t = testApp();
    const { account } = seedAccount(t.ctx);
    const web = createSession(t.ctx, account.id, "web");
    expect((await t.app.request("/api/pages", authed(web.token))).status).toBe(401);
  });
});

describe("devices", () => {
  test("a registered device receives jobs for new pages", async () => {
    const t = testApp();
    const token = await signIn(t.app);
    const res = await t.app.request("/api/devices/current", authed(token, { method: "PUT", body: JSON.stringify({ apns_token: TOKEN, platform: "ios", model: "iPhone17,1", apns_env: "sandbox" }) }));
    expect(res.status).toBe(200);
    const testRes = await t.app.request("/api/test", authed(token, { method: "POST" }));
    expect(testRes.status).toBe(202);
    expect(t.ctx.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM delivery_jobs").get()!.n).toBe(1);
  });

  test("invalid device bodies are 400", async () => {
    const t = testApp();
    const token = await signIn(t.app);
    const res = await t.app.request("/api/devices/current", authed(token, { method: "PUT", body: JSON.stringify({ apns_token: "nope", platform: "ios", model: "x", apns_env: "sandbox" }) }));
    expect(res.status).toBe(400);
  });

  test("logout revokes the session and removes the device", async () => {
    const t = testApp();
    const token = await signIn(t.app);
    await t.app.request("/api/devices/current", authed(token, { method: "PUT", body: JSON.stringify({ apns_token: TOKEN, platform: "ios", model: "x", apns_env: "sandbox" }) }));
    const account = getAccountByGoogleSub(t.ctx.db, "sub-1")!;
    expect((await t.app.request("/api/auth/logout", authed(token, { method: "POST" }))).status).toBe(204);
    expect(listDevicesForAccount(t.ctx.db, account.id)).toHaveLength(0);
    expect((await t.app.request("/api/pages", authed(token))).status).toBe(401);
  });
});

describe("GET /api/pages", () => {
  test("returns only the caller's pages, newest first, in the documented shape", async () => {
    const t = testApp();
    const token = await signIn(t.app);
    const mine = getAccountByGoogleSub(t.ctx.db, "sub-1")!;
    const other = seedAccount(t.ctx, "someone-else");
    addPage(t, other.account.id, "not yours");
    addPage(t, mine.id, "older");
    t.ctx.clock.advance(1000);
    const newest = addPage(t, mine.id, "newer");
    const body = (await (await t.app.request("/api/pages", authed(token))).json()) as { pages: Array<Record<string, unknown>>; next_before: string | null };
    expect(body.pages.map((p) => p.message)).toEqual(["newer", "older"]);
    expect(body.pages[0]).toEqual({
      id: newest.id,
      title: null,
      message: "newer",
      url: null,
      view_url: `https://pager.test/v/${newest.public_id}`,
      source: "trigger",
      created_at: new Date(newest.created_at).toISOString(),
    });
    expect(body.next_before).toBeNull();
  });

  test("paginates 120 pages without gaps or duplicates", async () => {
    const t = testApp({ config: testConfig({ limits: { pagesPerMinute: 1000, pagesPerDay: 1000, triggerRequestsPerIpPerMinute: 30 } }) });
    const token = await signIn(t.app);
    const account = getAccountByGoogleSub(t.ctx.db, "sub-1")!;
    for (let i = 0; i < 120; i++) {
      addPage(t, account.id, `m${i}`);
      if (i % 3 === 0) t.ctx.clock.advance(1); // also exercise identical timestamps
    }
    const seen: string[] = [];
    let before: string | null = null;
    do {
      const query: string = before ? `?before=${before}` : "";
      const body = (await (await t.app.request(`/api/pages${query}`, authed(token))).json()) as { pages: Array<{ id: string }>; next_before: string | null };
      seen.push(...body.pages.map((p) => p.id));
      before = body.next_before;
    } while (before);
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
  });

  test("bad limits and foreign or unknown cursors are 400", async () => {
    const t = testApp();
    const token = await signIn(t.app);
    const other = seedAccount(t.ctx, "other");
    const foreign = addPage(t, other.account.id, "x");
    for (const query of ["?limit=0", "?limit=101", "?limit=abc", "?limit=1.5", `?before=${foreign.id}`, "?before=pg_missing"]) {
      expect((await t.app.request(`/api/pages${query}`, authed(token))).status).toBe(400);
    }
  });

  test("pages older than 30 days are not returned", async () => {
    const t = testApp();
    const token = await signIn(t.app);
    const account = getAccountByGoogleSub(t.ctx.db, "sub-1")!;
    addPage(t, account.id, "ancient");
    t.ctx.clock.advance(30 * 24 * 60 * 60 * 1000 + 1);
    const body = (await (await t.app.request("/api/pages", authed(token))).json()) as { pages: unknown[] };
    expect(body.pages).toHaveLength(0);
  });
});

describe("POST /api/test", () => {
  test("creates a test page, wakes the worker and respects the rate limit", async () => {
    const t = testApp();
    const token = await signIn(t.app);
    const res = await t.app.request("/api/test", authed(token, { method: "POST" }));
    expect(res.status).toBe(202);
    expect(t.wakes.count).toBe(1);
    for (let i = 0; i < 9; i++) await t.app.request("/api/test", authed(token, { method: "POST" }));
    const limited = await t.app.request("/api/test", authed(token, { method: "POST" }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
  });
});
