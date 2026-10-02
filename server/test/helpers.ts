import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config";
import type { Ctx } from "../src/context";
import { openDatabase } from "../src/db/database";

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
