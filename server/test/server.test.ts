import { describe, expect, test } from "bun:test";
import { createLogger } from "../src/logging";
import { startServer } from "../src/server";
import { FakeSender, fakeGoogleOAuth, fakeGoogleVerifier, seedAccount, seedDevice, tempDbPath, testConfig } from "./helpers";

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function boot(databasePath: string, sender: FakeSender) {
  const config = testConfig({ databasePath, port: 0 });
  const running = startServer(config, {
    sender,
    google: fakeGoogleVerifier,
    googleOAuth: fakeGoogleOAuth,
    logger: createLogger(() => {}),
    shutdownTimeoutMs: 50,
  });
  return { running, ctx: { db: running.db, config, now: Date.now } };
}

describe("startServer", () => {
  test("a real HTTP trigger reaches the sender through the real worker", async () => {
    const sender = new FakeSender();
    const { running, ctx } = boot(tempDbPath(), sender);
    try {
      const { account, triggerToken } = seedAccount(ctx);
      seedDevice(ctx, account.id);
      const res = await fetch(`${running.url}/p/${triggerToken}`, { method: "POST", body: "from curl" });
      expect(res.status).toBe(202);
      await waitFor(() => sender.calls.length === 1);
      expect(sender.calls[0]!.message.body).toBe("from curl");
      expect((await fetch(`${running.url}/healthz`)).status).toBe(200);
    } finally {
      await running.stop();
    }
  });

  test("stop() is idempotent: a second call resolves to the same promise without throwing", async () => {
    const { running } = boot(tempDbPath(), new FakeSender());
    const first = running.stop();
    const second = running.stop();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    await running.stop();
  });

  test("a page accepted just before a restart is delivered by the next process", async () => {
    const path = tempDbPath();
    const stuck = new FakeSender();
    stuck.handler = () => new Promise(() => {});
    const first = boot(path, stuck);
    const { account, triggerToken } = seedAccount(first.ctx);
    seedDevice(first.ctx, account.id);
    expect((await fetch(`${first.running.url}/p/${triggerToken}`, { method: "POST" })).status).toBe(202);
    await waitFor(() => stuck.calls.length === 1);
    await first.running.stop();

    const healthy = new FakeSender();
    const second = boot(path, healthy);
    try {
      await waitFor(() => healthy.calls.length === 1);
    } finally {
      await second.running.stop();
    }
  });
});
