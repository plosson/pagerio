import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config";
import type { Ctx } from "../src/context";
import { openDatabase } from "../src/db/database";
import { type AccountRow, findOrCreateAccount, triggerUrl } from "../src/services/accounts";
import { type DeviceInput, type DeviceRow, registerCurrentDevice } from "../src/services/devices";
import { createSession, type SessionRow } from "../src/services/sessions";

export const T0 = Date.UTC(2026, 9, 2, 12, 0, 0);

export class FakeClock {
  constructor(public t: number = T0) {}
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    publicBaseUrl: "https://pager.test",
    databasePath: ":memory:",
    tokenEncKey: Buffer.alloc(32, 7),
    apns: { keyP8: "unused", keyId: "KEYID", teamId: "TEAMID", topics: { ios: "com.test.ios", macos: "com.test.mac" } },
    google: { webClientId: "web-client", webClientSecret: "web-secret", iosClientId: "ios-client", macosClientId: "mac-client" },
    limits: { pagesPerMinute: 10, pagesPerDay: 100, triggerRequestsPerIpPerMinute: 30 },
    ...overrides,
  };
}

export function testCtx(opts: { clock?: FakeClock; config?: Config; path?: string } = {}): Ctx & { clock: FakeClock } {
  const clock = opts.clock ?? new FakeClock();
  return { db: openDatabase(opts.path ?? ":memory:"), config: opts.config ?? testConfig(), now: clock.now, clock };
}

export function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "pagerio-")), "test.db");
}

export function seedAccount(ctx: Ctx, sub = "sub-1", email = "a@example.com"): { account: AccountRow; triggerToken: string } {
  const account = findOrCreateAccount(ctx, { sub, email });
  const triggerToken = triggerUrl(ctx, account.id).split("/p/")[1]!;
  return { account, triggerToken };
}

let deviceCounter = 0;

export function seedDevice(
  ctx: Ctx,
  accountId: string,
  overrides: Partial<DeviceInput> = {},
): { device: DeviceRow; sessionToken: string; session: SessionRow } {
  deviceCounter += 1;
  const { token, session } = createSession(ctx, accountId, "app");
  const device = registerCurrentDevice(ctx, session, {
    apnsToken: deviceCounter.toString(16).padStart(64, "0"),
    platform: "ios",
    model: "iPhone17,1",
    apnsEnv: "sandbox",
    ...overrides,
  });
  return { device, sessionToken: token, session: { ...session, device_id: device.id } };
}
