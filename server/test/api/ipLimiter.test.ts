import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { clientIp, FixedWindowLimiter } from "../../src/api/ipLimiter";
import { FakeClock } from "../helpers";

describe("FixedWindowLimiter", () => {
  test("allows up to the limit per key, then reports seconds until the window resets", () => {
    const clock = new FakeClock();
    const limiter = new FixedWindowLimiter(3, 60_000, clock.now);
    for (let i = 0; i < 3; i++) expect(limiter.hit("a")).toEqual({ ok: true });
    clock.advance(15_000);
    expect(limiter.hit("a")).toEqual({ ok: false, retryAfterSeconds: 45 });
    expect(limiter.hit("b")).toEqual({ ok: true });
    clock.advance(45_000);
    expect(limiter.hit("a")).toEqual({ ok: true });
  });

  test("forgets old keys when the window rolls over (no unbounded growth)", () => {
    const clock = new FakeClock();
    const limiter = new FixedWindowLimiter(1, 1000, clock.now);
    for (let i = 0; i < 500; i++) limiter.hit(`ip-${i}`);
    clock.advance(1000);
    limiter.hit("fresh");
    expect(limiter.size).toBe(1);
  });
});

describe("clientIp", () => {
  const app = new Hono().get("/", (c) => c.text(clientIp(c)));
  const ip = async (xff?: string) => (await app.request("/", { headers: xff ? { "x-forwarded-for": xff } : {} })).text();

  test("uses the rightmost X-Forwarded-For entry (the one the proxy added)", async () => {
    expect(await ip("203.0.113.9")).toBe("203.0.113.9");
    expect(await ip("1.1.1.1, 2.2.2.2,  203.0.113.9 ")).toBe("203.0.113.9");
  });

  test("falls back to 'unknown' without the header or with an empty one", async () => {
    expect(await ip()).toBe("unknown");
    expect(await ip(" , ")).toBe("unknown");
  });
});
