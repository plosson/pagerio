import { describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { getPageById } from "../../src/db/pages";
import { DEFAULT_MESSAGE } from "../../src/services/pageInput";
import { seedAccount, testApp, testConfig } from "../helpers";

function post(app: Hono, token: string, init: { body?: string; headers?: Record<string, string>; ip?: string } = {}) {
  return app.request(`/p/${token}`, {
    method: "POST",
    body: init.body,
    headers: { "x-forwarded-for": init.ip ?? "203.0.113.1", ...init.headers },
  });
}

const pageCount = (t: ReturnType<typeof testApp>) => t.ctx.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM pages").get()!.n;

describe("POST /p/:token", () => {
  test("an empty POST is accepted with the default message and wakes the worker", async () => {
    const t = testApp();
    const { triggerToken } = seedAccount(t.ctx);
    const res = await post(t.app, triggerToken);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { id: string; status: string; view_url: string };
    expect(body.status).toBe("accepted");
    expect(body.view_url).toMatch(/^https:\/\/pager\.test\/v\/[A-Za-z0-9]{16}$/);
    expect(getPageById(t.ctx.db, body.id)?.message).toBe(DEFAULT_MESSAGE);
    expect(t.wakes.count).toBe(1);
  });

  test("a JSON body is stored field by field", async () => {
    const t = testApp();
    const { triggerToken } = seedAccount(t.ctx);
    const res = await post(t.app, triggerToken, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Build", message: "Done", details: "**ok**", url: "https://e.com", group: "ci" }),
    });
    const { id } = (await res.json()) as { id: string };
    expect(getPageById(t.ctx.db, id)).toMatchObject({ title: "Build", message: "Done", details: "**ok**", url: "https://e.com/", group_key: "ci", source: "trigger" });
  });

  test("unknown and dead tokens get the exact same 404", async () => {
    const t = testApp();
    const { account, triggerToken } = seedAccount(t.ctx);
    t.ctx.db.query("DELETE FROM accounts WHERE id = $id").run({ id: account.id });
    const dead = await post(t.app, triggerToken);
    const unknown = await post(t.app, "x".repeat(43));
    const malformed = await post(t.app, "short");
    expect([dead.status, unknown.status, malformed.status]).toEqual([404, 404, 404]);
    const bodies = await Promise.all([dead.text(), unknown.text(), malformed.text()]);
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toEqual({ error: { code: "not_found", message: "Unknown pager URL." } });
  });

  test("GET (link previews, scanners) never creates a page and returns the Markdown guide with the URL", async () => {
    const t = testApp();
    const { triggerToken } = seedAccount(t.ctx);
    const res = await t.app.request(`/p/${triggerToken}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const text = await res.text();
    expect(text).toStartWith("# ");
    expect(text).toContain(`curl -X POST https://pager.test/p/${triggerToken}`);
    expect(pageCount(t)).toBe(0);
    expect(t.wakes.count).toBe(0);
  });

  test("GET gives the same guide for live, dead and unknown tokens, so it cannot be used to probe tokens", async () => {
    const t = testApp();
    const { account, triggerToken } = seedAccount(t.ctx);
    const unknown = "Z".repeat(16);
    const live = await (await t.app.request(`/p/${triggerToken}`)).text();
    t.ctx.db.query("DELETE FROM accounts WHERE id = $id").run({ id: account.id });
    const dead = await (await t.app.request(`/p/${triggerToken}`)).text();
    const other = await (await t.app.request(`/p/${unknown}`)).text();
    expect(dead).toBe(live);
    expect(other).toBe(live.replaceAll(triggerToken, unknown));
  });

  test("GET does not echo a token that is not token-shaped", async () => {
    const t = testApp();
    const res = await t.app.request(`/p/${encodeURIComponent("evil](https://attacker.test)<script>")}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("attacker");
    expect(text).not.toContain("<script>");
    expect(text).toContain("https://pager.test/p/<token>");
  });

  test("GET is not counted against the per-IP limit for unknown tokens", async () => {
    const t = testApp();
    const { triggerToken } = seedAccount(t.ctx);
    for (let i = 0; i < 50; i++) {
      const res = await t.app.request(`/p/${"Q".repeat(16)}`, { headers: { "x-forwarded-for": "203.0.113.9" } });
      expect(res.status).toBe(200);
    }
    expect((await post(t.app, triggerToken, { ip: "203.0.113.9" })).status).toBe(202);
    expect((await post(t.app, "Q".repeat(16), { ip: "203.0.113.9" })).status).toBe(404);
  });

  test("every JSON example in the guide is valid JSON that the endpoint accepts", async () => {
    const t = testApp();
    const { triggerToken } = seedAccount(t.ctx);
    const text = await (await t.app.request(`/p/${triggerToken}`)).text();
    const bodies = [...text.matchAll(/-H "Content-Type: application\/json" \\\n\s+-d '([^']+)'/g)].map((m) => m[1]!);
    expect(bodies.length).toBeGreaterThanOrEqual(4);
    for (const body of bodies) {
      const res = await post(t.app, triggerToken, { headers: { "content-type": "application/json" }, body });
      expect(res.status).toBe(202);
    }
  });

  test("other methods than GET and POST are still 405", async () => {
    const t = testApp();
    const { triggerToken } = seedAccount(t.ctx);
    for (const method of ["PUT", "DELETE", "PATCH"]) {
      const res = await t.app.request(`/p/${triggerToken}`, { method });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, POST");
    }
    expect(pageCount(t)).toBe(0);
  });

  test("a body of exactly 16,384 bytes is accepted and one byte more is 413", async () => {
    const t = testApp();
    const { triggerToken } = seedAccount(t.ctx);
    const base = JSON.stringify({ details: "d".repeat(10_000) });
    const exact = base + " ".repeat(16_384 - base.length);
    const ok = await post(t.app, triggerToken, { headers: { "content-type": "application/json" }, body: exact });
    expect(ok.status).toBe(202);
    const tooBig = await post(t.app, triggerToken, { headers: { "content-type": "application/json" }, body: exact + " " });
    expect(tooBig.status).toBe(413);
    expect(pageCount(t)).toBe(1);
  });

  test("a lying Content-Length over the limit is refused up front", async () => {
    const t = testApp();
    const { triggerToken } = seedAccount(t.ctx);
    const res = await post(t.app, triggerToken, { headers: { "content-length": "99999999" }, body: "hi" });
    expect(res.status).toBe(413);
  });

  test("invalid input is a 400 that does not echo the body", async () => {
    const t = testApp();
    const { triggerToken } = seedAccount(t.ctx);
    const res = await post(t.app, triggerToken, { headers: { "content-type": "application/json" }, body: "{TOP-SECRET" });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text).error.code).toBe("invalid_input");
    expect(text).not.toContain("TOP-SECRET");
  });

  test("the 11th page in a minute is 429 with Retry-After", async () => {
    const t = testApp();
    const { triggerToken } = seedAccount(t.ctx);
    for (let i = 0; i < 10; i++) expect((await post(t.app, triggerToken)).status).toBe(202);
    const res = await post(t.app, triggerToken);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
  });

  test("concurrent retries with one Idempotency-Key create one page", async () => {
    const t = testApp();
    const { triggerToken } = seedAccount(t.ctx);
    const send = () => post(t.app, triggerToken, { headers: { "idempotency-key": "deploy-42" }, body: "x" });
    const [a, b] = await Promise.all([send(), send()]);
    const [ja, jb] = (await Promise.all([a.json(), b.json()])) as Array<{ id: string }>;
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(ja!.id).toBe(jb!.id);
    expect(pageCount(t)).toBe(1);
  });

  test("an Idempotency-Key over 200 characters is rejected", async () => {
    const t = testApp();
    const { triggerToken } = seedAccount(t.ctx);
    const res = await post(t.app, triggerToken, { headers: { "idempotency-key": "k".repeat(201) } });
    expect(res.status).toBe(400);
  });

  test("the per-IP limit on unknown tokens cannot be dodged by spoofing the left of X-Forwarded-For", async () => {
    const config = testConfig({ limits: { pagesPerMinute: 1000, pagesPerDay: 1000, triggerRequestsPerIpPerMinute: 30 } });
    const t = testApp({ config });
    const unknown = "x".repeat(43);
    for (let i = 0; i < 30; i++) expect((await post(t.app, unknown, { ip: `10.0.0.${i}, 203.0.113.1` })).status).toBe(404);
    const blocked = await post(t.app, unknown, { ip: "10.9.9.9, 203.0.113.1" });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).not.toBeNull();
    expect((await post(t.app, unknown, { ip: "198.51.100.7" })).status).toBe(404);
  });

  test("an IP limited by unknown tokens can still trigger with a valid token", async () => {
    const config = testConfig({ limits: { pagesPerMinute: 1000, pagesPerDay: 1000, triggerRequestsPerIpPerMinute: 30 } });
    const t = testApp({ config });
    const { triggerToken } = seedAccount(t.ctx);
    for (let i = 0; i < 30; i++) await post(t.app, "x".repeat(43));
    expect((await post(t.app, "x".repeat(43))).status).toBe(429);
    expect((await post(t.app, triggerToken)).status).toBe(202);
  });

  test("logs never contain the token or the message", async () => {
    const t = testApp();
    const { triggerToken } = seedAccount(t.ctx);
    await post(t.app, triggerToken, { body: "TOP-SECRET-MESSAGE" });
    await post(t.app, triggerToken, { headers: { "content-type": "application/json" }, body: "{TOP-SECRET-JSON" });
    const logs = t.logLines.join("\n");
    expect(logs).toContain("/p/***");
    expect(logs).not.toContain(triggerToken);
    expect(logs).not.toContain("TOP-SECRET");
  });

  test("a database failure is a generic 500, logged without details", async () => {
    const t = testApp();
    const { triggerToken } = seedAccount(t.ctx);
    t.ctx.db.close();
    const res = await post(t.app, triggerToken);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "internal", message: "Something went wrong. Try again." } });
    expect(t.logLines.join("\n")).toContain("unhandled_error");
  });
});
