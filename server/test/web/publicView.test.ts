import { describe, expect, test } from "bun:test";
import { createPage } from "../../src/services/pages";
import type { PageInput } from "../../src/services/pageInput";
import { seedAccount, testApp } from "../helpers";

function makePage(t: ReturnType<typeof testApp>, input: Partial<PageInput> = {}) {
  const { account, triggerToken } = seedAccount(t.ctx);
  const r = createPage(t.ctx, {
    accountId: account.id,
    input: { title: null, message: "hello", details: null, url: null, group: null, ...input },
    source: "trigger",
    idempotencyKey: null,
  });
  if (!r.ok) throw new Error("rate limited");
  return { page: r.page, triggerToken, account };
}

describe("GET /v/:publicId", () => {
  test("renders title, message, Markdown details and the link without sign-in", async () => {
    const t = testApp();
    const { page } = makePage(t, { title: "Build finished", message: "Ready", details: "**All green**", url: "https://ci.example/1" });
    const res = await t.app.request(`/v/${page.public_id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h1>Build finished</h1>");
    expect(html).toContain("Ready");
    expect(html).toContain("<strong>All green</strong>");
    expect(html).toContain('href="https://ci.example/1"');
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  test("escapes hostile titles and messages", async () => {
    const t = testApp();
    const { page } = makePage(t, { title: '<img src=x onerror="alert(1)">', message: "<script>alert(2)</script>" });
    const html = await (await t.app.request(`/v/${page.public_id}`)).text();
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert(2)");
  });

  test("an attribute-breaking URL cannot inject attributes", async () => {
    const t = testApp();
    const { page } = makePage(t, { url: 'https://e.com/"onmouseover="alert(1)' });
    const html = await (await t.app.request(`/v/${page.public_id}`)).text();
    expect(html).not.toContain('"onmouseover="');
  });

  test("never exposes the account's trigger URL", async () => {
    const t = testApp();
    const { page, triggerToken } = makePage(t);
    expect(await (await t.app.request(`/v/${page.public_id}`)).text()).not.toContain(triggerToken);
  });

  test("unknown, malformed, expired and deleted pages are a noindex 404", async () => {
    const t = testApp();
    const { page } = makePage(t);
    for (const id of ["x".repeat(43), "short", "..%2F..%2Fetc"]) {
      const res = await t.app.request(`/v/${id}`);
      expect(res.status).toBe(404);
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }
    t.ctx.clock.advance(30 * 24 * 60 * 60 * 1000 + 1);
    expect((await t.app.request(`/v/${page.public_id}`)).status).toBe(404);

    const fresh = testApp();
    const second = makePage(fresh);
    fresh.ctx.db.query("DELETE FROM accounts WHERE id = $id").run({ id: second.account.id });
    expect((await fresh.app.request(`/v/${second.page.public_id}`)).status).toBe(404);
  });
});
