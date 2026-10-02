import { describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { getAccountByGoogleSub } from "../../src/db/accounts";
import { triggerUrl } from "../../src/services/accounts";
import { createPage } from "../../src/services/pages";
import { createSession } from "../../src/services/sessions";
import { CSP } from "../../src/web/http";
import { seedAccount, testApp } from "../helpers";

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
    expect(html).toMatch(/href="https:\/\/pager\.test\/v\/[A-Za-z0-9_-]{43}"/);
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
    expect(html).toContain("<strong>EMPTY-TITLE-MSG</strong>");
    expect(html).not.toContain("<strong></strong>");
    expect(html).not.toContain("— EMPTY-TITLE-MSG");
  });
});
