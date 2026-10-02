import { describe, expect, test } from "bun:test";
import { createPage, TEST_PAGE_INPUT, viewUrl } from "../../src/services/pages";
import { DEFAULT_MESSAGE, type PageInput } from "../../src/services/pageInput";
import { seedAccount, seedDevice, testCtx } from "../helpers";

const input = (message = "hello"): PageInput => ({ title: null, message, details: null, url: null, group: null });
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function count(ctx: ReturnType<typeof testCtx>, table: string): number {
  return ctx.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
}

describe("createPage", () => {
  test("stores the page and one pending job per device, due now", () => {
    const ctx = testCtx();
    const { account } = seedAccount(ctx);
    seedDevice(ctx, account.id);
    seedDevice(ctx, account.id, { platform: "macos" });
    const result = createPage(ctx, { accountId: account.id, input: input(), source: "trigger", idempotencyKey: null });
    expect(result.ok && result.created).toBe(true);
    const jobs = ctx.db.query<{ status: string; next_attempt_at: number }, []>("SELECT status, next_attempt_at FROM delivery_jobs").all();
    expect(jobs).toEqual([
      { status: "pending", next_attempt_at: ctx.clock.t },
      { status: "pending", next_attempt_at: ctx.clock.t },
    ]);
  });

  test("an account without devices still gets its page, with no jobs", () => {
    const ctx = testCtx();
    const { account } = seedAccount(ctx);
    expect(createPage(ctx, { accountId: account.id, input: input(), source: "trigger", idempotencyKey: null }).ok).toBe(true);
    expect(count(ctx, "pages")).toBe(1);
    expect(count(ctx, "delivery_jobs")).toBe(0);
  });

  test("does not page devices of other accounts", () => {
    const ctx = testCtx();
    const a = seedAccount(ctx, "a");
    const b = seedAccount(ctx, "b");
    seedDevice(ctx, b.account.id);
    createPage(ctx, { accountId: a.account.id, input: input(), source: "trigger", idempotencyKey: null });
    expect(count(ctx, "delivery_jobs")).toBe(0);
  });

  test("public_id is a fresh 43-character token distinct from the id", () => {
    const ctx = testCtx();
    const { account } = seedAccount(ctx);
    const r1 = createPage(ctx, { accountId: account.id, input: input(), source: "trigger", idempotencyKey: null });
    const r2 = createPage(ctx, { accountId: account.id, input: input(), source: "trigger", idempotencyKey: null });
    if (!r1.ok || !r2.ok) throw new Error("expected ok");
    expect(r1.page.public_id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r1.page.public_id).not.toBe(r2.page.public_id);
    expect(viewUrl(ctx.config, r1.page.public_id)).toBe(`https://pager.test/v/${r1.page.public_id}`);
  });

  describe("idempotency", () => {
    test("the same key within 24 hours returns the original page and creates nothing", () => {
      const ctx = testCtx();
      const { account } = seedAccount(ctx);
      seedDevice(ctx, account.id);
      const first = createPage(ctx, { accountId: account.id, input: input("one"), source: "trigger", idempotencyKey: "k1" });
      ctx.clock.advance(DAY - 1);
      const again = createPage(ctx, { accountId: account.id, input: input("two"), source: "trigger", idempotencyKey: "k1" });
      if (!first.ok || !again.ok) throw new Error("expected ok");
      expect(again.page.id).toBe(first.page.id);
      expect(again.created).toBe(false);
      expect(again.page.message).toBe("one");
      expect(count(ctx, "pages")).toBe(1);
      expect(count(ctx, "delivery_jobs")).toBe(1);
    });

    test("the same key after 24 hours creates a new page", () => {
      const ctx = testCtx();
      const { account } = seedAccount(ctx);
      createPage(ctx, { accountId: account.id, input: input(), source: "trigger", idempotencyKey: "k1" });
      ctx.clock.advance(DAY + 1);
      const later = createPage(ctx, { accountId: account.id, input: input(), source: "trigger", idempotencyKey: "k1" });
      expect(later.ok && later.created).toBe(true);
      expect(count(ctx, "pages")).toBe(2);
    });

    test("the same key on two accounts creates two pages", () => {
      const ctx = testCtx();
      const a = seedAccount(ctx, "a");
      const b = seedAccount(ctx, "b");
      createPage(ctx, { accountId: a.account.id, input: input(), source: "trigger", idempotencyKey: "shared" });
      const other = createPage(ctx, { accountId: b.account.id, input: input(), source: "trigger", idempotencyKey: "shared" });
      expect(other.ok && other.created).toBe(true);
    });

    test("a replay is answered even when the account is rate-limited", () => {
      const ctx = testCtx();
      const { account } = seedAccount(ctx);
      const original = createPage(ctx, { accountId: account.id, input: input(), source: "trigger", idempotencyKey: "k" });
      for (let i = 0; i < 9; i++) createPage(ctx, { accountId: account.id, input: input(), source: "trigger", idempotencyKey: null });
      const replay = createPage(ctx, { accountId: account.id, input: input(), source: "trigger", idempotencyKey: "k" });
      expect(replay.ok && original.ok && replay.page.id === original.page.id).toBe(true);
    });
  });

  describe("rate limits", () => {
    test("the 11th page in a minute is refused with an accurate Retry-After", () => {
      const ctx = testCtx();
      const { account } = seedAccount(ctx);
      for (let i = 0; i < 10; i++) {
        expect(createPage(ctx, { accountId: account.id, input: input(), source: "trigger", idempotencyKey: null }).ok).toBe(true);
        ctx.clock.advance(1000);
      }
      const refused = createPage(ctx, { accountId: account.id, input: input(), source: "trigger", idempotencyKey: null });
      expect(refused).toEqual({ ok: false, code: "rate_limited", retryAfterSeconds: 50 });
      expect(count(ctx, "pages")).toBe(10);
      ctx.clock.advance(50_000);
      expect(createPage(ctx, { accountId: account.id, input: input(), source: "trigger", idempotencyKey: null }).ok).toBe(true);
    });

    test("the daily cap applies even when pages are spread out", () => {
      const ctx = testCtx();
      const { account } = seedAccount(ctx);
      for (let i = 0; i < 100; i++) {
        expect(createPage(ctx, { accountId: account.id, input: input(), source: "trigger", idempotencyKey: null }).ok).toBe(true);
        ctx.clock.advance(7 * MINUTE);
      }
      const refused = createPage(ctx, { accountId: account.id, input: input(), source: "trigger", idempotencyKey: null });
      expect(refused.ok).toBe(false);
      expect(!refused.ok && refused.retryAfterSeconds).toBeGreaterThan(0);
    });

    test("test pages count towards the limit", () => {
      const ctx = testCtx();
      const { account } = seedAccount(ctx);
      for (let i = 0; i < 10; i++) createPage(ctx, { accountId: account.id, input: TEST_PAGE_INPUT, source: "test", idempotencyKey: null });
      expect(createPage(ctx, { accountId: account.id, input: input(), source: "trigger", idempotencyKey: null }).ok).toBe(false);
    });

    test("one account's burst does not limit another account", () => {
      const ctx = testCtx();
      const a = seedAccount(ctx, "a");
      const b = seedAccount(ctx, "b");
      for (let i = 0; i < 11; i++) createPage(ctx, { accountId: a.account.id, input: input(), source: "trigger", idempotencyKey: null });
      expect(createPage(ctx, { accountId: b.account.id, input: input(), source: "trigger", idempotencyKey: null }).ok).toBe(true);
    });
  });

  test("TEST_PAGE_INPUT is a complete, valid input", () => {
    expect(TEST_PAGE_INPUT.message).not.toBe(DEFAULT_MESSAGE);
    expect(TEST_PAGE_INPUT.title).toBe("Pocket Pager");
  });
});
