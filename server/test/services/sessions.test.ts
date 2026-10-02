import { describe, expect, test } from "bun:test";
import { findOrCreateAccount } from "../../src/services/accounts";
import { createSession, resolveSession, revokeSession, SESSION_IDLE_TTL_MS } from "../../src/services/sessions";
import { testCtx } from "../helpers";

function setup() {
  const ctx = testCtx();
  const account = findOrCreateAccount(ctx, { sub: "s1", email: "a@example.com" });
  return { ctx, account };
}

describe("sessions", () => {
  test("a created session resolves only with its own kind", () => {
    const { ctx, account } = setup();
    const { token, session } = createSession(ctx, account.id, "app");
    expect(resolveSession(ctx, token, "app")?.id).toBe(session.id);
    expect(resolveSession(ctx, token, "web")).toBeNull();
  });

  test("unknown, malformed and empty tokens do not resolve", () => {
    const { ctx } = setup();
    for (const bad of ["", "nope", "a".repeat(43), "a".repeat(5000)]) expect(resolveSession(ctx, bad, "app")).toBeNull();
  });

  test("only the hash is stored", () => {
    const { ctx, account } = setup();
    const { token } = createSession(ctx, account.id, "web");
    const row = ctx.db.query("SELECT * FROM sessions").get() as Record<string, unknown>;
    for (const value of Object.values(row)) expect(String(value)).not.toBe(token);
  });

  test("idle sessions expire after 90 days and are deleted; activity keeps them alive", () => {
    const { ctx, account } = setup();
    const { token } = createSession(ctx, account.id, "app");
    ctx.clock.advance(SESSION_IDLE_TTL_MS - 1000);
    expect(resolveSession(ctx, token, "app")).not.toBeNull(); // touches last_used_at
    ctx.clock.advance(SESSION_IDLE_TTL_MS - 1000);
    expect(resolveSession(ctx, token, "app")).not.toBeNull();
    ctx.clock.advance(SESSION_IDLE_TTL_MS + 1);
    expect(resolveSession(ctx, token, "app")).toBeNull();
    expect(ctx.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sessions").get()?.n).toBe(0);
  });

  test("a revoked session no longer resolves", () => {
    const { ctx, account } = setup();
    const { token, session } = createSession(ctx, account.id, "web");
    revokeSession(ctx, session);
    expect(resolveSession(ctx, token, "web")).toBeNull();
  });

  test("deleting the account kills its sessions", () => {
    const { ctx, account } = setup();
    const { token } = createSession(ctx, account.id, "app");
    ctx.db.query("DELETE FROM accounts WHERE id = $id").run({ id: account.id });
    expect(resolveSession(ctx, token, "app")).toBeNull();
  });
});
