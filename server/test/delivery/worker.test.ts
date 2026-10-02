import { describe, expect, test } from "bun:test";
import { openDatabase } from "../../src/db/database";
import type { JobRow } from "../../src/db/jobs";
import { DeliveryWorker, RETRY_DELAYS_MS } from "../../src/delivery/worker";
import { createLogger } from "../../src/logging";
import { resolveSession } from "../../src/services/sessions";
import { createPage } from "../../src/services/pages";
import type { PageInput } from "../../src/services/pageInput";
import { FakeClock, FakeSender, seedAccount, seedDevice, tempDbPath, testConfig, testCtx } from "../helpers";

type Ctx = ReturnType<typeof testCtx>;

function setup(ctx: Ctx = testCtx(), options: ConstructorParameters<typeof DeliveryWorker>[1] = {}) {
  const sender = new FakeSender();
  const logs: string[] = [];
  const worker = new DeliveryWorker({ ...ctx, sender, logger: createLogger((l) => logs.push(l)) }, options);
  return { ctx, sender, worker, logs };
}

function page(ctx: Ctx, accountId: string, input: Partial<PageInput> = {}) {
  const result = createPage(ctx, {
    accountId,
    input: { title: null, message: "hello", details: null, url: null, group: null, ...input },
    source: "trigger",
    idempotencyKey: null,
  });
  if (!result.ok) throw new Error("rate limited");
  return result.page;
}

const jobs = (ctx: Ctx) => ctx.db.query<JobRow, []>("SELECT * FROM delivery_jobs").all();
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("DeliveryWorker", () => {
  test("submits one notification per device with the right target and message", async () => {
    const { ctx, sender, worker } = setup();
    const { account } = seedAccount(ctx);
    seedDevice(ctx, account.id);
    const { device: mac } = seedDevice(ctx, account.id, { platform: "macos", apnsEnv: "production" });
    const p = page(ctx, account.id, { title: "Build", message: "Done", url: "https://e.com/1", group: "ci" });

    expect(worker.tick()).toBe(2);
    await worker.idle();

    expect(jobs(ctx).map((j) => j.status)).toEqual(["submitted", "submitted"]);
    expect(jobs(ctx).every((j) => j.apns_id?.startsWith("apns-"))).toBe(true);
    const call = sender.calls.find((c) => c.target.platform === "macos")!;
    expect(call.target).toEqual({ token: mac.apns_token, env: "production", platform: "macos" });
    expect(call.message).toEqual({
      title: "Build",
      body: "Done",
      threadId: "ci",
      publicId: p.public_id,
      viewUrl: `https://pager.test/v/${p.public_id}`,
      url: "https://e.com/1",
      expiresAtSeconds: Math.floor(p.created_at / 1000) + 3600,
    });
  });

  test("uses the 'pages' thread when no group is given and does nothing when idle", async () => {
    const { ctx, sender, worker } = setup();
    expect(worker.tick()).toBe(0);
    const { account } = seedAccount(ctx);
    seedDevice(ctx, account.id);
    page(ctx, account.id);
    worker.tick();
    await worker.idle();
    expect(sender.calls[0]!.message.threadId).toBe("pages");
  });

  test("retries transient errors on the 5s/30s/2m/10m schedule, then fails", async () => {
    const { ctx, sender, worker } = setup();
    const { account } = seedAccount(ctx);
    seedDevice(ctx, account.id);
    page(ctx, account.id);
    sender.results = Array.from({ length: 5 }, () => ({ kind: "retry" as const, reason: "HTTP 503" }));

    worker.tick();
    await worker.idle();
    for (const [index, delay] of RETRY_DELAYS_MS.entries()) {
      const job = jobs(ctx)[0]!;
      expect(job).toMatchObject({ status: "pending", attempts: index + 1, next_attempt_at: ctx.clock.t + delay, last_error: "HTTP 503" });
      ctx.clock.advance(delay - 1);
      expect(worker.tick()).toBe(0);
      ctx.clock.advance(1);
      expect(worker.tick()).toBe(1);
      await worker.idle();
    }
    expect(jobs(ctx)[0]).toMatchObject({ status: "failed", last_error: "HTTP 503" });
    expect(sender.calls).toHaveLength(5);
  });

  test("a permanent failure is not retried", async () => {
    const { ctx, sender, worker } = setup();
    const { account } = seedAccount(ctx);
    seedDevice(ctx, account.id);
    page(ctx, account.id);
    sender.results = [{ kind: "fail", reason: "DeviceTokenNotForTopic" }];
    worker.tick();
    await worker.idle();
    expect(jobs(ctx)[0]).toMatchObject({ status: "failed", attempts: 0, last_error: "DeviceTokenNotForTopic" });
    ctx.clock.advance(3_600_000);
    expect(worker.tick()).toBe(0);
  });

  test("a dead token removes the device, its session, and fails its queued jobs without sending", async () => {
    const { ctx, sender, worker } = setup(testCtx(), { batchSize: 1 });
    const { account } = seedAccount(ctx);
    const { sessionToken } = seedDevice(ctx, account.id);
    page(ctx, account.id, { message: "first" });
    ctx.clock.advance(1);
    page(ctx, account.id, { message: "second" });
    sender.results = [{ kind: "invalid-token", reason: "Unregistered" }];

    expect(worker.tick()).toBe(1);
    await worker.idle();
    expect(ctx.db.query("SELECT * FROM devices").all()).toHaveLength(0);
    expect(resolveSession(ctx, sessionToken, "app")).toBeNull();

    expect(worker.tick()).toBe(1);
    await worker.idle();
    expect(jobs(ctx).map((j) => j.last_error).sort()).toEqual(["Unregistered", "device_removed"]);
    expect(jobs(ctx).every((j) => j.status === "failed")).toBe(true);
    expect(sender.calls).toHaveLength(1);
  });

  test("a slow APNs response does not hold up later pages", async () => {
    const { ctx, sender, worker } = setup();
    const { account } = seedAccount(ctx);
    seedDevice(ctx, account.id);
    let release: () => void = () => {};
    sender.handler = async (_t, message) => {
      if (message.body === "slow") await new Promise<void>((resolve) => (release = resolve));
      return { kind: "ok", apnsId: message.body };
    };
    page(ctx, account.id, { message: "slow" });
    worker.tick();
    page(ctx, account.id, { message: "fast" });
    worker.tick();
    await flush();
    const byId = (id: string) => jobs(ctx).find((j) => j.apns_id === id);
    expect(byId("fast")?.status).toBe("submitted");
    expect(jobs(ctx).filter((j) => j.status === "sending")).toHaveLength(1);
    release();
    await worker.idle();
    expect(byId("slow")?.status).toBe("submitted");
  });

  test("respects maxInFlight", async () => {
    const { ctx, sender, worker } = setup(testCtx(), { maxInFlight: 1 });
    const { account } = seedAccount(ctx);
    seedDevice(ctx, account.id);
    sender.handler = () => new Promise(() => {});
    page(ctx, account.id);
    page(ctx, account.id);
    expect(worker.tick()).toBe(1);
    expect(worker.tick()).toBe(0);
  });

  test("after a crash mid-send, the next worker re-sends the job (at-least-once)", async () => {
    const ctx = testCtx();
    const { account } = seedAccount(ctx);
    seedDevice(ctx, account.id);
    page(ctx, account.id);
    const crashed = setup(ctx);
    crashed.sender.handler = () => new Promise(() => {}); // process "dies" while waiting for APNs
    crashed.worker.tick();
    expect(jobs(ctx)[0]!.status).toBe("sending");

    const next = setup(ctx);
    expect(next.worker.recover()).toBe(1);
    expect(next.worker.tick()).toBe(1);
    await next.worker.idle();
    expect(jobs(ctx)[0]!.status).toBe("submitted");
  });

  test("an accepted page survives closing and reopening the database", async () => {
    const path = tempDbPath();
    const clock = new FakeClock();
    const first = testCtx({ path, clock });
    const { account } = seedAccount(first);
    seedDevice(first, account.id);
    page(first, account.id);
    first.db.close();

    const reopened = { db: openDatabase(path), config: testConfig(), now: clock.now, clock };
    const { worker, sender } = setup(reopened);
    worker.recover();
    expect(worker.tick()).toBe(1);
    await worker.idle();
    expect(sender.calls).toHaveLength(1);
  });

  test("pages older than one hour are marked expired, not sent (stale backlog)", async () => {
    const { ctx, sender, worker } = setup();
    const { account } = seedAccount(ctx);
    seedDevice(ctx, account.id);
    page(ctx, account.id);
    ctx.clock.advance(3_600_000);
    worker.tick();
    await worker.idle();
    expect(jobs(ctx)[0]).toMatchObject({ status: "failed", last_error: "expired" });
    expect(sender.calls).toHaveLength(0);
  });

  test("an exception from the sender is retried, not left stuck in 'sending'", async () => {
    const { ctx, sender, worker } = setup();
    const { account } = seedAccount(ctx);
    seedDevice(ctx, account.id);
    page(ctx, account.id);
    sender.handler = async () => {
      throw new Error("bug");
    };
    worker.tick();
    await worker.idle();
    expect(jobs(ctx)[0]).toMatchObject({ status: "pending", attempts: 1, last_error: "sender_exception" });
  });

  test("deleting the account while a send is in flight does not crash the worker", async () => {
    const { ctx, sender, worker, logs } = setup();
    const { account } = seedAccount(ctx);
    seedDevice(ctx, account.id);
    page(ctx, account.id);
    let release: () => void = () => {};
    sender.handler = () => new Promise((resolve) => (release = () => resolve({ kind: "invalid-token", reason: "Unregistered" })));
    worker.tick();
    ctx.db.query("DELETE FROM accounts").run();
    release();
    await worker.idle();
    expect(jobs(ctx)).toHaveLength(0);
    expect(logs.join("\n")).not.toContain("delivery_crashed");
  });

  test("wake() delivers without waiting for the interval", async () => {
    const { ctx, sender, worker } = setup();
    const { account } = seedAccount(ctx);
    seedDevice(ctx, account.id);
    page(ctx, account.id);
    worker.wake();
    await flush();
    await worker.idle();
    expect(sender.calls).toHaveLength(1);
  });

  test("logs outcomes but never message content", async () => {
    const { ctx, worker, logs } = setup();
    const { account } = seedAccount(ctx);
    seedDevice(ctx, account.id);
    page(ctx, account.id, { title: "TOP-SECRET-TITLE", message: "TOP-SECRET-BODY" });
    worker.tick();
    await worker.idle();
    expect(logs.join("\n")).toContain('"outcome":"ok"');
    expect(logs.join("\n")).not.toContain("TOP-SECRET");
  });
});
