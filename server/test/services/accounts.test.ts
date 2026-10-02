import { describe, expect, test } from "bun:test";
import { findAccountByTriggerToken, findOrCreateAccount, triggerUrl } from "../../src/services/accounts";
import { testCtx } from "../helpers";

describe("findOrCreateAccount", () => {
  test("creates once per Google subject and refreshes the email", () => {
    const ctx = testCtx();
    const first = findOrCreateAccount(ctx, { sub: "s1", email: "old@example.com" });
    const again = findOrCreateAccount(ctx, { sub: "s1", email: "new@example.com" });
    expect(again.id).toBe(first.id);
    expect(again.email).toBe("new@example.com");
    expect(ctx.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM accounts").get()?.n).toBe(1);
  });

  test("different subjects with the same email are different accounts", () => {
    const ctx = testCtx();
    const a = findOrCreateAccount(ctx, { sub: "s1", email: "same@example.com" });
    const b = findOrCreateAccount(ctx, { sub: "s2", email: "same@example.com" });
    expect(a.id).not.toBe(b.id);
    expect(triggerUrl(ctx, a.id)).not.toBe(triggerUrl(ctx, b.id));
  });
});

describe("trigger URL", () => {
  test("has the base URL and a 16-char alphanumeric token, and resolves back to the account", () => {
    const ctx = testCtx();
    const account = findOrCreateAccount(ctx, { sub: "s1", email: "a@example.com" });
    const url = triggerUrl(ctx, account.id);
    expect(url).toMatch(/^https:\/\/pager\.test\/p\/[A-Za-z0-9]{16}$/);
    const token = url.split("/p/")[1]!;
    expect(findAccountByTriggerToken(ctx, token)?.id).toBe(account.id);
  });

  test("the plain token is not stored anywhere in the accounts table", () => {
    const ctx = testCtx();
    const account = findOrCreateAccount(ctx, { sub: "s1", email: "a@example.com" });
    const token = triggerUrl(ctx, account.id).split("/p/")[1]!;
    const row = ctx.db.query("SELECT * FROM accounts").get() as Record<string, unknown>;
    for (const value of Object.values(row)) expect(String(value)).not.toContain(token);
  });

  test("near-miss, malformed and hostile tokens do not resolve", () => {
    const ctx = testCtx();
    const account = findOrCreateAccount(ctx, { sub: "s1", email: "a@example.com" });
    const token = triggerUrl(ctx, account.id).split("/p/")[1]!;
    const flipped = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    for (const bad of [flipped, token.slice(0, 15), token + "x", token.toLowerCase() === token ? token.toUpperCase() : token.toLowerCase(), "a".repeat(43), "", "../../etc/passwd", "' OR 1=1 --", "x".repeat(10_000)]) {
      expect(findAccountByTriggerToken(ctx, bad)).toBeNull();
    }
  });

  test("triggerUrl throws for an unknown account", () => {
    expect(() => triggerUrl(testCtx(), "acct_missing")).toThrow();
  });
});
