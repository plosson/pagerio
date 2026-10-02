import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createLogger, redactPath, requestLogger } from "../src/logging";

describe("redactPath", () => {
  test("hides trigger tokens and public ids, keeps everything else", () => {
    expect(redactPath("/p/abcDEF123")).toBe("/p/***");
    expect(redactPath("/v/abcDEF123")).toBe("/v/***");
    expect(redactPath("/v/abc/extra")).toBe("/v/***/extra");
    expect(redactPath("/api/pages")).toBe("/api/pages");
    expect(redactPath("/pp/abc")).toBe("/pp/abc");
    expect(redactPath("/")).toBe("/");
  });
});

describe("createLogger", () => {
  test("writes one JSON object per line with level, event and fields", () => {
    const lines: string[] = [];
    createLogger((l) => lines.push(l)).error("boom", { code: 7 });
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({ level: "error", event: "boom", code: 7 });
    expect(typeof entry.time).toBe("string");
  });

  test("caller fields can never overwrite time, level or event", () => {
    const lines: string[] = [];
    createLogger((l) => lines.push(l)).info("real_event", { time: "forged", level: "error", event: "forged_event", other: 1 } as never);
    const entry = JSON.parse(lines[0]!);
    expect(entry.event).toBe("real_event");
    expect(entry.level).toBe("info");
    expect(entry.time).not.toBe("forged");
    expect(Number.isNaN(Date.parse(entry.time))).toBe(false);
    expect(entry.other).toBe(1);
  });
});

describe("requestLogger", () => {
  test("logs method, redacted path, status and duration but never the query string", async () => {
    const lines: string[] = [];
    const app = new Hono();
    app.use("*", requestLogger(createLogger((l) => lines.push(l))));
    app.post("/p/:token", (c) => c.text("ok", 202));
    await app.request("/p/SECRET_TOKEN?code=SECRET_CODE", { method: "POST" });
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({ event: "http", method: "POST", path: "/p/***", status: 202 });
    expect(lines.join("\n")).not.toContain("SECRET");
  });
});
