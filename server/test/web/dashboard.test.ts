import { describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { getAccountByGoogleSub } from "../../src/db/accounts";
import { triggerUrl } from "../../src/services/accounts";
import { createPage } from "../../src/services/pages";
import { createSession } from "../../src/services/sessions";
import { CSP } from "../../src/web/http";
import type { PageInput } from "../../src/services/pageInput";
import { seedAccount, seedDevice, testApp, testConfig } from "../helpers";

function cookieFrom(res: Response, name: string): string | null {
  for (const header of res.headers.getSetCookie()) {
    const match = new RegExp(`^${name}=([^;]*)`).exec(header);
    if (match?.[1]) return match[1];
  }
  return null;
}

async function signIn(app: Hono, code = "user1") {
  const start = await app.request("/auth/google");
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const stateCookie = cookieFrom(start, "pp_oauth_state")!;
  const res = await app.request(`/auth/google/callback?state=${encodeURIComponent(state)}&code=${code}`, {
    headers: { cookie: `pp_oauth_state=${stateCookie}` },
  });
  return { res, session: cookieFrom(res, "pp_session") };
}

const home = (app: Hono, session: string) => app.request("/", { headers: { cookie: `pp_session=${session}` } });
const csrfFrom = (html: string) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";

function postForm(app: Hono, path: string, session: string, fields: Record<string, string>) {
  return app.request(path, {
    method: "POST",
    body: new URLSearchParams(fields).toString(),
    headers: { cookie: `pp_session=${session}`, "content-type": "application/x-www-form-urlencoded" },
  });
}

describe("signed out", () => {
  test("the home page offers Google sign-in under a strict CSP", async () => {
    const res = await testApp().app.request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('href="/auth/google"');
    expect(res.headers.get("content-security-policy")).toBe(CSP);
    expect(CSP).not.toContain("unsafe-inline");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  test("static assets are served", async () => {
    const t = testApp();
    expect((await t.app.request("/static/app.js")).status).toBe(200);
    expect((await t.app.request("/static/style.css")).status).toBe(200);
  });
});

describe("Google sign-in", () => {
  test("a matching state creates the account and an HttpOnly session cookie", async () => {
    const t = testApp();
    const { res, session } = await signIn(t.app);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    const setCookie = res.headers.getSetCookie().find((h) => h.startsWith("pp_session="))!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Secure");
    const account = getAccountByGoogleSub(t.ctx.db, "user1")!;
    const html = await (await home(t.app, session!)).text();
    expect(html).toContain(triggerUrl(t.ctx, account.id));
    expect(html).toContain("user1@example.com");
    expect(html).toContain("No devices yet");
  });

  test("a mismatched, missing or absent state never signs in", async () => {
    const t = testApp();
    const start = await t.app.request("/auth/google");
    const stateCookie = cookieFrom(start, "pp_oauth_state")!;
    const attempts = [
      t.app.request("/auth/google/callback?state=forged&code=user1", { headers: { cookie: `pp_oauth_state=${stateCookie}` } }),
      t.app.request(`/auth/google/callback?state=${stateCookie}&code=user1`),
      t.app.request("/auth/google/callback?code=user1", { headers: { cookie: `pp_oauth_state=${stateCookie}` } }),
      t.app.request(`/auth/google/callback?state=${stateCookie}`, { headers: { cookie: `pp_oauth_state=${stateCookie}` } }),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(400);
      expect(cookieFrom(res, "pp_session")).toBeNull();
    }
    expect(t.ctx.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM accounts").get()!.n).toBe(0);
  });

  test("Google errors and failed code exchanges do not sign in", async () => {
    const t = testApp();
    const cancelled = await t.app.request("/auth/google/callback?error=access_denied");
    expect(cancelled.status).toBe(303);
    expect(cookieFrom(cancelled, "pp_session")).toBeNull();
    const { res, session } = await signIn(t.app, "bad");
    expect(res.status).toBe(401);
    expect(session).toBeNull();
  });

  test("an app session token is not a web session", async () => {
    const t = testApp();
    const { account } = seedAccount(t.ctx);
    const app = createSession(t.ctx, account.id, "app");
    expect(await (await home(t.app, app.token)).text()).toContain('href="/auth/google"');
  });
});

describe("dashboard forms", () => {
  test("Test my pager requires the CSRF token", async () => {
    const t = testApp();
    const { session } = await signIn(t.app);
    const csrf = csrfFrom(await (await home(t.app, session!)).text());
    expect(csrf).not.toBe("");

    expect((await postForm(t.app, "/test", session!, {})).status).toBe(403);
    expect((await postForm(t.app, "/test", session!, { _csrf: "wrong" })).status).toBe(403);
    expect(t.ctx.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM pages").get()!.n).toBe(0);

    const ok = await postForm(t.app, "/test", session!, { _csrf: csrf });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/?sent=1");
    expect(t.wakes.count).toBe(1);
    expect(t.ctx.db.query<{ source: string }, []>("SELECT source FROM pages").get()!.source).toBe("test");
  });

  test("Test my pager while signed out does nothing", async () => {
    const t = testApp();
    const res = await t.app.request("/test", { method: "POST" });
    expect(res.status).toBe(303);
    expect(t.ctx.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM pages").get()!.n).toBe(0);
  });

  test("sign-out needs the CSRF token, then really ends the session", async () => {
    const t = testApp();
    const { session } = await signIn(t.app);
    const csrf = csrfFrom(await (await home(t.app, session!)).text());
    await postForm(t.app, "/auth/logout", session!, {});
    expect(await (await home(t.app, session!)).text()).not.toContain('href="/auth/google"');
    await postForm(t.app, "/auth/logout", session!, { _csrf: csrf });
    expect(await (await home(t.app, session!)).text()).toContain('href="/auth/google"');
  });
});

describe("caching", () => {
  test("the signed-in dashboard is never cached", async () => {
    const t = testApp();
    const { session } = await signIn(t.app);
    expect((await home(t.app, session!)).headers.get("cache-control")).toBe("no-store");
    expect((await t.app.request("/")).headers.get("cache-control")).toBe("no-store");
  });
});

describe("recent pages", () => {
  test("shows only the signed-in account's pages, escaped, linking to the public view", async () => {
    const t = testApp();
    const { session } = await signIn(t.app);
    const mine = getAccountByGoogleSub(t.ctx.db, "user1")!;
    const other = seedAccount(t.ctx, "other");
    const mineToken = triggerUrl(t.ctx, mine.id).split("/p/")[1]!;
    await t.app.request(`/p/${mineToken}`, { method: "POST", body: "<script>alert(1)</script>" });
    await t.app.request(`/p/${other.triggerToken}`, { method: "POST", body: "someone else's page" });
    const html = await (await home(t.app, session!)).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("someone else");
    expect(html).toMatch(/href="https:\/\/pager\.test\/v\/[A-Za-z0-9]{16}"/);
  });

  test("a page with an empty title shows its message as the link text, without a dangling dash", async () => {
    const t = testApp();
    const { session } = await signIn(t.app);
    const mine = getAccountByGoogleSub(t.ctx.db, "user1")!;
    const r = createPage(t.ctx, {
      accountId: mine.id,
      input: { title: "", message: "EMPTY-TITLE-MSG", details: null, url: null, group: null },
      source: "trigger",
      idempotencyKey: null,
    });
    if (!r.ok) throw new Error("rate limited");
    const html = await (await home(t.app, session!)).text();
    expect(html).toContain('<span class="row-title sender" dir="auto">EMPTY-TITLE-MSG</span>');
    expect(html).not.toContain('<span class="row-title sender" dir="auto"></span>');
    expect(html).not.toContain('class="row-message');
    expect(html).not.toContain("— EMPTY-TITLE-MSG");
  });
});

describe("dashboard layout and stress", () => {
  const roomy = testConfig({ limits: { pagesPerMinute: 5000, pagesPerDay: 5000, triggerRequestsPerIpPerMinute: 30 } });

  async function setup() {
    const t = testApp({ config: roomy });
    const { session } = await signIn(t.app);
    const account = getAccountByGoogleSub(t.ctx.db, "user1")!;
    const add = (input: Partial<PageInput> = {}) => {
      const r = createPage(t.ctx, { accountId: account.id, input: { title: null, message: "m", details: null, url: null, group: null, ...input }, source: "trigger", idempotencyKey: null });
      if (!r.ok) throw new Error("rate limited");
      return r.page;
    };
    return { t, session: session!, account, add, html: async (q = "") => (await t.app.request(`/${q}`, { headers: { cookie: `pp_session=${session}` } })).text() };
  }

  test("the pager URL and Copy come before Test my pager, the curl guide and the recent pages; curl is folded", async () => {
    const { t, account, html } = await setup();
    const page = await html();
    const order = [triggerUrl(t.ctx, account.id), 'data-copy="pager-url"', "Test my pager", "<details", "Recent pages"].map((s) => page.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(page).toMatch(/<details id="how"><summary>How to send a page<\/summary><pre><code>curl -X POST/);
  });

  test("never uses inline styles or inline scripts, which the CSP would block", async () => {
    const { add, html } = await setup();
    add({ title: "x" });
    const page = await html();
    expect(page).not.toMatch(/\sstyle=/);
    expect(page).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
    expect(page).not.toMatch(/\son[a-z]+=/);
  });

  test("37 identical pages from a looping script show as one row with ×37 and a counted failure", async () => {
    const { t, add, html } = await setup();
    seedDevice(t.ctx, getAccountByGoogleSub(t.ctx.db, "user1")!.id);
    add({ title: "Calm", message: "before" });
    t.ctx.clock.advance(60_000);
    const burst = [];
    for (let i = 0; i < 37; i++) {
      burst.push(add({ title: "Deploy failed", message: "rollout stopped" }));
      t.ctx.clock.advance(8_000);
    }
    const job = t.ctx.db.query<{ id: string }, { p: string }>("SELECT id FROM delivery_jobs WHERE page_id = $p").get({ p: burst[5]!.id })!;
    t.ctx.db.query("UPDATE delivery_jobs SET status = 'failed' WHERE id = $id").run({ id: job.id });
    const page = await html();
    expect(page.match(/>Deploy failed</g)).toHaveLength(1);
    expect(page).toContain("×37");
    expect(page).toContain("1 failed");
    expect(page).toContain(">Calm<");
  });

  test("timestamps are relative, never raw ISO text, and a page from the future is 'just now'", async () => {
    const { t, add, html } = await setup();
    add({ title: "old" });
    t.ctx.clock.advance(2 * 60 * 60 * 1000);
    const future = add({ title: "future" });
    t.ctx.db.query("UPDATE pages SET created_at = created_at + 3600000 WHERE id = $id").run({ id: future.id });
    const page = await html();
    expect(page).toContain(">just now</time>");
    expect(page).toContain(">2 h ago</time>");
    expect(page).not.toMatch(/>\d{4}-\d\d-\d\dT[^<]*<\/time>/);
    expect(page).not.toContain("ago</time>-");
  });

  test("1,000 pages: 20 rows, a total and 'Show 20 more', which grows the list", async () => {
    const { t, add, html } = await setup();
    for (let i = 0; i < 1000; i++) {
      add({ title: `Page ${i}`, message: `body ${i}` });
      t.ctx.clock.advance(1000);
    }
    const first = await html();
    expect(first.match(/<li><a href=/g)).toHaveLength(20);
    expect(first).toContain("Showing 20 of 1,000 pages");
    expect(first).toContain('href="/?show=40"');
    const second = await html("?show=40");
    expect(second.match(/<li><a href=/g)).toHaveLength(40);
    expect(second).toContain('href="/?show=60"');
  });

  test("hostile show values never break the page or load unbounded rows", async () => {
    const { t, add, html } = await setup();
    for (let i = 0; i < 25; i++) {
      add({ title: `Page ${i}` });
      t.ctx.clock.advance(1000);
    }
    for (const q of ["abc", "-5", "0", "1e9", "99999999999999999999", "20.5", "%00", "40&show=1000000"]) {
      const page = await html(`?show=${q}`);
      const rows = page.match(/<li><a href=/g)?.length ?? 0;
      expect(rows).toBeGreaterThanOrEqual(20);
      expect(rows).toBeLessThanOrEqual(25);
    }
    expect((await html("?show=100000")).match(/<li><a href=/g)).toHaveLength(25);
  });

  test("no 'Show more' when everything is already shown", async () => {
    const { add, html } = await setup();
    add();
    const page = await html();
    expect(page).not.toContain("Show 20 more");
  });

  test("sender text wraps and follows its own direction; a script tag stays text", async () => {
    const { add, html } = await setup();
    add({ title: "فشل النشر في بيئة الإنتاج", message: "x".repeat(200) });
    add({ title: "<script>alert('pwned')</script>", message: "<img src=x onerror=alert(1)>" });
    const page = await html();
    expect(page).toContain('<span class="row-title sender" dir="auto">فشل النشر في بيئة الإنتاج</span>');
    expect(page).toContain(`<span class="row-message sender" dir="auto">${"x".repeat(200)}</span>`);
    expect(page).not.toContain("<script>alert");
    expect(page).not.toContain("<img src=x");
  });

  test("the newest page gets the new-page dot only while it is recent, and no other row ever does", async () => {
    const { t, add, html } = await setup();
    add({ title: "a" });
    add({ title: "b" });
    expect((await html()).match(/class="dot new"/g)).toHaveLength(1);
    t.ctx.clock.advance(16 * 60 * 1000);
    expect(await html()).not.toContain('class="dot new"');
  });

  test("device status pairs an icon with words and names each platform once", async () => {
    const { t, account, html } = await setup();
    seedDevice(t.ctx, account.id);
    seedDevice(t.ctx, account.id, { platform: "macos", model: "Mac" });
    seedDevice(t.ctx, account.id);
    const page = await html();
    expect(page).toContain("3 devices will ring · iPhone, Mac");
    expect(page.toLowerCase()).not.toContain("delivered");
  });

  test("a rate-limited test page says so in words, without an error code", async () => {
    const { html } = await setup();
    const page = await html("?limited=1");
    expect(page).toContain("Too many pages right now. Try again in a minute.");
    expect(page).not.toContain("429");
  });
});
