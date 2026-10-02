import { describe, expect, test } from "bun:test";
import { listDevicesForAccount } from "../../src/db/devices";
import { parseDeviceInput, registerCurrentDevice } from "../../src/services/devices";
import { createSession, resolveSession, revokeSession } from "../../src/services/sessions";
import { seedAccount, testCtx } from "../helpers";

const TOKEN_A = "a1".repeat(32);
const TOKEN_B = "b2".repeat(32);
const input = (apnsToken = TOKEN_A) => ({ apnsToken, platform: "ios" as const, model: "iPhone17,1", apnsEnv: "sandbox" as const });

describe("parseDeviceInput", () => {
  test("accepts a well-formed body and lowercases the token", () => {
    const parsed = parseDeviceInput({ apns_token: TOKEN_A.toUpperCase(), platform: "macos", model: " Mac15,3 ", apns_env: "production" });
    expect(parsed).toEqual({ ok: true, value: { apnsToken: TOKEN_A, platform: "macos", model: "Mac15,3", apnsEnv: "production" } });
  });

  test("caps an overlong model at 100 characters", () => {
    const parsed = parseDeviceInput({ apns_token: TOKEN_A, platform: "ios", model: "m".repeat(500), apns_env: "sandbox" });
    expect(parsed.ok && parsed.value.model.length).toBe(100);
  });

  const bad: Array<[string, unknown]> = [
    ["null", null],
    ["an array", [1]],
    ["a string", "hello"],
    ["a non-hex token", { apns_token: "zz".repeat(32), platform: "ios", model: "x", apns_env: "sandbox" }],
    ["a short token", { apns_token: "ab".repeat(10), platform: "ios", model: "x", apns_env: "sandbox" }],
    ["a huge token", { apns_token: "ab".repeat(500), platform: "ios", model: "x", apns_env: "sandbox" }],
    ["an unknown platform", { apns_token: TOKEN_A, platform: "android", model: "x", apns_env: "sandbox" }],
    ["an unknown environment", { apns_token: TOKEN_A, platform: "ios", model: "x", apns_env: "development" }],
    ["a numeric token", { apns_token: 1234, platform: "ios", model: "x", apns_env: "sandbox" }],
    ["a missing model", { apns_token: TOKEN_A, platform: "ios", apns_env: "sandbox" }],
  ];
  for (const [name, body] of bad) {
    test(`rejects ${name}`, () => expect(parseDeviceInput(body).ok).toBe(false));
  }
});

describe("registerCurrentDevice", () => {
  test("first registration creates a device and links it to the session", () => {
    const ctx = testCtx();
    const { account } = seedAccount(ctx);
    const { token, session } = createSession(ctx, account.id, "app");
    const device = registerCurrentDevice(ctx, session, input());
    expect(resolveSession(ctx, token, "app")?.device_id).toBe(device.id);
    expect(listDevicesForAccount(ctx.db, account.id).map((d) => d.id)).toEqual([device.id]);
  });

  test("a new APNs token for the same session updates the same device", () => {
    const ctx = testCtx();
    const { account } = seedAccount(ctx);
    const { token, session } = createSession(ctx, account.id, "app");
    const first = registerCurrentDevice(ctx, session, input(TOKEN_A));
    const second = registerCurrentDevice(ctx, resolveSession(ctx, token, "app")!, input(TOKEN_B));
    expect(second.id).toBe(first.id);
    expect(second.apns_token).toBe(TOKEN_B);
    expect(listDevicesForAccount(ctx.db, account.id)).toHaveLength(1);
  });

  test("a token registered by another account moves to the new account (phone changed hands)", () => {
    const ctx = testCtx();
    const alice = seedAccount(ctx, "alice", "alice@example.com");
    const bob = seedAccount(ctx, "bob", "bob@example.com");
    const aliceSession = createSession(ctx, alice.account.id, "app");
    registerCurrentDevice(ctx, aliceSession.session, input(TOKEN_A));
    const bobSession = createSession(ctx, bob.account.id, "app");
    registerCurrentDevice(ctx, bobSession.session, input(TOKEN_A));
    expect(listDevicesForAccount(ctx.db, alice.account.id)).toHaveLength(0);
    expect(listDevicesForAccount(ctx.db, bob.account.id)).toHaveLength(1);
    expect(resolveSession(ctx, aliceSession.token, "app")).toBeNull();
  });

  test("a reinstall (new session, same token) replaces the old device instead of duplicating it", () => {
    const ctx = testCtx();
    const { account } = seedAccount(ctx);
    const old = createSession(ctx, account.id, "app");
    registerCurrentDevice(ctx, old.session, input(TOKEN_A));
    const fresh = createSession(ctx, account.id, "app");
    registerCurrentDevice(ctx, fresh.session, input(TOKEN_A));
    expect(listDevicesForAccount(ctx.db, account.id)).toHaveLength(1);
    expect(resolveSession(ctx, old.token, "app")).toBeNull();
    expect(resolveSession(ctx, fresh.token, "app")).not.toBeNull();
  });

  test("two phones on one account are two devices", () => {
    const ctx = testCtx();
    const { account } = seedAccount(ctx);
    registerCurrentDevice(ctx, createSession(ctx, account.id, "app").session, input(TOKEN_A));
    registerCurrentDevice(ctx, createSession(ctx, account.id, "app").session, input(TOKEN_B));
    expect(listDevicesForAccount(ctx.db, account.id)).toHaveLength(2);
  });
});

describe("revokeSession", () => {
  test("signing out of the app removes that device so it stops receiving pages", () => {
    const ctx = testCtx();
    const { account } = seedAccount(ctx);
    const { token, session } = createSession(ctx, account.id, "app");
    registerCurrentDevice(ctx, session, input());
    revokeSession(ctx, resolveSession(ctx, token, "app")!);
    expect(listDevicesForAccount(ctx.db, account.id)).toHaveLength(0);
  });

  test("signing out of the web leaves devices alone", () => {
    const ctx = testCtx();
    const { account } = seedAccount(ctx);
    registerCurrentDevice(ctx, createSession(ctx, account.id, "app").session, input());
    const web = createSession(ctx, account.id, "web");
    revokeSession(ctx, web.session);
    expect(listDevicesForAccount(ctx.db, account.id)).toHaveLength(1);
  });
});
