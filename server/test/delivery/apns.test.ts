import { afterEach, describe, expect, test } from "bun:test";
import http2 from "node:http2";
import { exportPKCS8, generateKeyPair } from "jose";
import {
  buildPayload,
  classifyResponse,
  createApnsSender,
  MAX_PAYLOAD_BYTES,
  ProviderTokenCache,
  type ApnsMessage,
} from "../../src/delivery/apns";

const bytes = (s: string) => new TextEncoder().encode(s).length;

function message(overrides: Partial<ApnsMessage> = {}): ApnsMessage {
  return {
    title: null,
    body: "Deploy finished",
    threadId: "pages",
    publicId: "pub",
    viewUrl: "https://pager.test/v/pub",
    url: null,
    expiresAtSeconds: 2_000_000_000,
    ...overrides,
  };
}

describe("buildPayload", () => {
  test("omits title and category when absent", () => {
    const payload = JSON.parse(buildPayload(message()));
    expect(payload.aps.alert).toEqual({ body: "Deploy finished" });
    expect(payload.aps.category).toBeUndefined();
    expect(payload.aps.sound).toBe("pager.caf");
    expect(payload.aps["interruption-level"]).toBe("time-sensitive");
    expect(payload.aps["thread-id"]).toBe("pages");
    expect(payload.url).toBeUndefined();
    expect(payload.view_url).toBe("https://pager.test/v/pub");
    expect(payload.public_id).toBe("pub");
  });

  test("adds the link category and url when a url is present", () => {
    const payload = JSON.parse(buildPayload(message({ title: "Build", url: "https://x.test/1" })));
    expect(payload.aps.alert).toEqual({ title: "Build", body: "Deploy finished" });
    expect(payload.aps.category).toBe("PAGE_WITH_LINK");
    expect(payload.url).toBe("https://x.test/1");
  });

  test("stays under the APNs limit with maximal emoji content and a maximal url", () => {
    const m = message({
      title: "🚨".repeat(100),
      body: "🔥".repeat(1000),
      url: "https://example.com/" + "a".repeat(2048 - 20),
      threadId: "g".repeat(50),
    });
    const json = buildPayload(m);
    expect(bytes(json)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    const body: string = JSON.parse(json).aps.alert.body;
    expect(body.endsWith("…")).toBe(true);
    expect(() => encodeURIComponent(body)).not.toThrow(); // no lone surrogate halves
  });

  test("accounts for JSON escaping when truncating", () => {
    const nasty = '"\\\n\u0001'.repeat(250); // 1,000 characters, most escape to 2–6 bytes
    const json = buildPayload(message({ body: nasty, url: "https://e.com/" + "b".repeat(2000) }));
    expect(bytes(json)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    const body: string = JSON.parse(json).aps.alert.body;
    expect(nasty.startsWith(body.slice(0, -1))).toBe(true);
  });
});

describe("classifyResponse", () => {
  test("200 is ok and keeps the apns-id", () => {
    expect(classifyResponse(200, "", "id-1")).toEqual({ kind: "ok", apnsId: "id-1" });
  });
  test("410, BadDeviceToken and DeviceTokenNotForTopic mean the token is dead", () => {
    expect(classifyResponse(410, '{"reason":"Unregistered"}', undefined)).toEqual({ kind: "invalid-token", reason: "Unregistered" });
    expect(classifyResponse(400, '{"reason":"BadDeviceToken"}', undefined).kind).toBe("invalid-token");
    // A token from another app, such as an old build: other devices still get the page with the same topic.
    expect(classifyResponse(400, '{"reason":"DeviceTokenNotForTopic"}', undefined)).toEqual({ kind: "invalid-token", reason: "DeviceTokenNotForTopic" });
  });
  test("server-side problems never delete a device: they would sign out every app at once", () => {
    for (const reason of ["BadTopic", "MissingTopic", "TopicDisallowed", "BadEnvironmentKeyInToken", "BadCertificateEnvironment", "BadPath", "PayloadEmpty"]) {
      expect(classifyResponse(400, JSON.stringify({ reason }), undefined)).toEqual({ kind: "fail", reason });
    }
    expect(classifyResponse(403, '{"reason":"InvalidProviderToken"}', undefined).kind).toBe("fail");
    expect(classifyResponse(413, '{"reason":"PayloadTooLarge"}', undefined).kind).toBe("fail");
  });
  test("a dead-token reason only counts with its own status", () => {
    expect(classifyResponse(403, '{"reason":"DeviceTokenNotForTopic"}', undefined).kind).toBe("fail");
    expect(classifyResponse(500, '{"reason":"BadDeviceToken"}', undefined).kind).toBe("retry");
    expect(classifyResponse(400, '{"reason":"devicetokennotfortopic"}', undefined).kind).toBe("fail");
    expect(classifyResponse(400, '{"reason":["DeviceTokenNotForTopic"]}', undefined).kind).toBe("fail");
  });
  test("429, 5xx and an expired provider token are retried", () => {
    expect(classifyResponse(429, '{"reason":"TooManyRequests"}', undefined).kind).toBe("retry");
    expect(classifyResponse(503, "", undefined)).toEqual({ kind: "retry", reason: "HTTP 503" });
    expect(classifyResponse(403, '{"reason":"ExpiredProviderToken"}', undefined).kind).toBe("retry");
    expect(classifyResponse(403, '{"reason":"InvalidProviderToken"}', undefined).kind).toBe("fail");
  });
  test("garbage bodies do not throw and reasons are bounded", () => {
    expect(classifyResponse(500, "<html>oops", undefined)).toEqual({ kind: "retry", reason: "HTTP 500" });
    const long = JSON.stringify({ reason: "x".repeat(5000) });
    const result = classifyResponse(400, long, undefined);
    expect(result.kind === "fail" && result.reason.length).toBe(200);
  });
});

describe("ProviderTokenCache", () => {
  test("concurrent sends share one signed token, including after expiry", async () => {
    let t = 1_000_000;
    let signs = 0;
    const cache = new ProviderTokenCache(async () => {
      const sequence = ++signs;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return `jwt-${sequence}`;
    }, () => t);
    expect(await Promise.all([cache.get(), cache.get(), cache.get()])).toEqual(["jwt-1", "jwt-1", "jwt-1"]);
    t += 50 * 60_000;
    expect(await Promise.all([cache.get(), cache.get()])).toEqual(["jwt-2", "jwt-2"]);
    expect(signs).toBe(2);
  });

  test("a late expired-token response does not invalidate the replacement", async () => {
    let signs = 0;
    const cache = new ProviderTokenCache(async () => `jwt-${++signs}`);
    const old = await cache.get();
    cache.invalidate(old);
    expect(await cache.get()).toBe("jwt-2");
    cache.invalidate(old);
    expect(await cache.get()).toBe("jwt-2");
    expect(signs).toBe(2);
  });

  test("reuses a token for 50 minutes, then re-signs; invalidate forces a new one", async () => {
    let t = 1_000_000;
    let signs = 0;
    const cache = new ProviderTokenCache(async (iat) => `jwt-${++signs}-${iat}`, () => t);
    expect(await cache.get()).toBe("jwt-1-1000");
    t += 49 * 60_000;
    expect(await cache.get()).toBe("jwt-1-1000");
    t += 60_000;
    expect(await cache.get()).toMatch(/^jwt-2-/);
    cache.invalidate();
    expect(await cache.get()).toMatch(/^jwt-3-/);
  });
});

describe("createApnsSender against a local HTTP/2 server", () => {
  type Seen = { headers: http2.IncomingHttpHeaders; body: string };
  let server: http2.Http2Server | null = null;
  let sender: ReturnType<typeof createApnsSender> | null = null;

  afterEach(() => {
    sender?.close();
    server?.close();
    server = null;
    sender = null;
  });

  async function start(respond: (stream: http2.ServerHttp2Stream, seen: Seen) => void): Promise<{ origin: string; seen: Seen[] }> {
    const seen: Seen[] = [];
    server = http2.createServer();
    server.on("stream", (stream: http2.ServerHttp2Stream, headers) => {
      let body = "";
      stream.on("data", (d) => (body += d));
      stream.on("end", () => {
        const entry = { headers, body };
        seen.push(entry);
        respond(stream, entry);
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    return { origin: `http://127.0.0.1:${port}`, seen };
  }

  async function makeSender(origin: string, timeoutMs = 2000) {
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const keyP8 = await exportPKCS8(privateKey);
    sender = createApnsSender(
      { keyP8, keyId: "KID", teamId: "TEAM", topics: { ios: "com.test.ios", macos: "com.test.mac" } },
      { hosts: { sandbox: origin, production: origin }, timeoutMs },
    );
    return sender;
  }

  test("sends the expected request and reports ok", async () => {
    const { origin, seen } = await start((stream) => {
      stream.respond({ ":status": 200, "apns-id": "abc-123" });
      stream.end();
    });
    const s = await makeSender(origin);
    const result = await s.send({ token: "ab".repeat(32), env: "sandbox", platform: "macos" }, message());
    expect(result).toEqual({ kind: "ok", apnsId: "abc-123" });
    const h = seen[0]!.headers;
    expect(h[":path"]).toBe(`/3/device/${"ab".repeat(32)}`);
    expect(h["apns-topic"]).toBe("com.test.mac");
    expect(h["apns-push-type"]).toBe("alert");
    expect(h["apns-priority"]).toBe("10");
    expect(h["apns-expiration"]).toBe("2000000000");
    expect(String(h.authorization)).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(JSON.parse(seen[0]!.body).aps.alert.body).toBe("Deploy finished");
  });

  test("410 is reported as an invalid token", async () => {
    const { origin } = await start((stream) => {
      stream.respond({ ":status": 410 });
      stream.end(JSON.stringify({ reason: "Unregistered" }));
    });
    const s = await makeSender(origin);
    expect(await s.send({ token: "cd".repeat(32), env: "production", platform: "ios" }, message())).toEqual({
      kind: "invalid-token",
      reason: "Unregistered",
    });
  });

  test("a server that never answers produces a retry after the timeout", async () => {
    const { origin } = await start(() => {
      /* never respond */
    });
    const s = await makeSender(origin, 150);
    const started = Date.now();
    expect(await s.send({ token: "ef".repeat(32), env: "sandbox", platform: "ios" }, message())).toEqual({ kind: "retry", reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("an unreachable host produces a retry, not an exception", async () => {
    const s = await makeSender("http://127.0.0.1:1", 500);
    const result = await s.send({ token: "ab".repeat(32), env: "sandbox", platform: "ios" }, message());
    expect(result.kind).toBe("retry");
  });

  test("a non-hex token is rejected without any network call", async () => {
    const { origin, seen } = await start((stream) => {
      stream.respond({ ":status": 200 });
      stream.end();
    });
    const s = await makeSender(origin);
    expect((await s.send({ token: "../../etc", env: "sandbox", platform: "ios" }, message())).kind).toBe("invalid-token");
    expect(seen.length).toBe(0);
  });

  test("a reset stream retires the connection before retrying", async () => {
    let firstSession: http2.Http2Session | undefined;
    let count = 0;
    const { origin } = await start((stream) => {
      stream.on("error", () => {});
      if (++count === 1) {
        firstSession = stream.session;
        stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
      } else {
        expect(stream.session).not.toBe(firstSession);
        stream.respond({ ":status": 200, "apns-id": "recovered" });
        stream.end();
      }
    });
    const s = await makeSender(origin);
    const target = { token: "ab".repeat(32), env: "sandbox" as const, platform: "ios" as const };
    expect((await s.send(target, message())).kind).toBe("retry");
    expect(await s.send(target, message())).toEqual({ kind: "ok", apnsId: "recovered" });
  });

  test("timeout destroys the session, so a second send uses a fresh connection", async () => {
    let requestCount = 0;
    const { origin, seen } = await start((stream) => {
      requestCount++;
      if (requestCount === 1) {
        // Never respond to first request (will timeout)
      } else {
        // Answer subsequent requests
        stream.respond({ ":status": 200, "apns-id": "ok-123" });
        stream.end();
      }
    });
    const s = await makeSender(origin, 100);
    // First send times out
    const result1 = await s.send({ token: "ab".repeat(32), env: "sandbox", platform: "ios" }, message());
    expect(result1).toEqual({ kind: "retry", reason: "timeout" });
    // Second send should succeed with fresh session (not reuse dead connection)
    const result2 = await s.send({ token: "cd".repeat(32), env: "sandbox", platform: "ios" }, message());
    expect(result2).toEqual({ kind: "ok", apnsId: "ok-123" });
    expect(seen.length).toBe(2); // Both requests made
  });
});

describe("createApnsSender with malformed key", () => {
  test("malformed key does not throw or reject on creation", async () => {
    // This should NOT throw
    const sender = createApnsSender({
      keyP8: "-----BEGIN PRIVATE KEY-----\ngarbage\n-----END PRIVATE KEY-----",
      keyId: "KID",
      teamId: "TEAM",
      topics: { ios: "com.test.ios", macos: "com.test.mac" },
    });
    expect(sender).toBeDefined();
    sender.close();
  });

  test("malformed key causes send to return fail with provider_token_error", async () => {
    const sender = createApnsSender({
      keyP8: "-----BEGIN PRIVATE KEY-----\ngarbage\n-----END PRIVATE KEY-----",
      keyId: "KID",
      teamId: "TEAM",
      topics: { ios: "com.test.ios", macos: "com.test.mac" },
    });
    const result = await sender.send({ token: "ab".repeat(32), env: "sandbox", platform: "ios" }, message());
    expect(result).toEqual({ kind: "fail", reason: "provider_token_error" });
    sender.close();
  });
});
