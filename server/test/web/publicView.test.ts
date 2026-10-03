import { describe, expect, test } from "bun:test";
import { createPage } from "../../src/services/pages";
import type { PageInput } from "../../src/services/pageInput";
import { seedAccount, seedDevice, testApp } from "../helpers";

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
    expect(html).toContain('<h1 class="sender" dir="auto">Build finished</h1>');
    expect(html).toContain('<p class="text" dir="auto">Ready</p>');
    expect(html).toContain("Ready");
    expect(html).toContain("<strong>All green</strong>");
    expect(html).toContain('href="https://ci.example/1"');
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  test("an empty title falls back to the message in the h1 and the message is not repeated", async () => {
    const t = testApp();
    const { page } = makePage(t, { title: "", message: "EMPTY-TITLE-MSG" });
    const html = await (await t.app.request(`/v/${page.public_id}`)).text();
    expect(html).toContain('<h1 class="text" dir="auto">EMPTY-TITLE-MSG</h1>');
    expect(html.match(/EMPTY-TITLE-MSG/g)).toHaveLength(1);
    expect(html).not.toMatch(/<h1[^>]*><\/h1>/);
    expect(html).toContain("<title>Pocket Pager</title>");
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
    for (const id of ["x".repeat(16), "x".repeat(43), page.public_id + "x", page.public_id.slice(0, 15), page.public_id.slice(0, 15) + "-", "short", "..%2F..%2Fetc"]) {
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

  test("the message sits in the pager display, a long unbroken string can wrap, and the text follows its direction", async () => {
    const t = testApp();
    const long = "ERR_TOKEN_" + "x7Fq2Lm9Pz".repeat(20);
    const { page } = makePage(t, { title: long, message: "توقف الطرح" });
    const html = await (await t.app.request(`/v/${page.public_id}`)).text();
    expect(html).toContain(`<h1 class="sender" dir="auto">${long}</h1>`);
    expect(html).toContain('<div class="display"><span class="label">Message</span><p class="text" dir="auto">توقف الطرح</p></div>');
  });

  test("delivery is reported honestly as sent, never delivered", async () => {
    const t = testApp();
    const { account } = seedAccount(t.ctx);
    seedDevice(t.ctx, account.id);
    seedDevice(t.ctx, account.id);
    const { page } = makePage(t);
    t.ctx.db.query("UPDATE delivery_jobs SET status = 'submitted' WHERE page_id = $id").run({ id: page.id });
    const html = await (await t.app.request(`/v/${page.public_id}`)).text();
    expect(html).toContain("Sent to 2 devices");
    expect(html.toLowerCase()).not.toContain("delivered");
  });

  test("the Open link button appears only with a link, and there are no inline styles or scripts", async () => {
    const t = testApp();
    const withLink = makePage(t, { url: "https://ci.example/1" }).page;
    const without = makePage(t, {}).page;
    const a = await (await t.app.request(`/v/${withLink.public_id}`)).text();
    const b = await (await t.app.request(`/v/${without.public_id}`)).text();
    expect(a).toContain("Open link");
    expect(b).not.toContain("Open link");
    for (const html of [a, b]) {
      expect(html).not.toMatch(/\sstyle=/);
      expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
    }
  });
});
