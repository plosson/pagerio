# Pocket Pager — Phases 1–2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the server, the shared Swift package and the iOS and macOS apps up to the phase 2 milestone. A curl request to a personal URL sounds on a signed-in iPhone and Mac, and every page has a public view.

**Architecture:**
- **Server:** one Bun process runs a Hono HTTP server (trigger endpoint, app API, server-rendered web dashboard, public page view) and an in-process delivery worker. Pages and per-device delivery jobs are written to SQLite in one transaction before `202` is returned. The worker claims due jobs and sends them to APNs over HTTP/2.
- **Apple apps:** a local Swift package (PagerKit) holds networking, session, device registration, pages and notification routing. The iOS and macOS targets are thin SwiftUI shells generated with XcodeGen.

**Tech Stack:**
- **Server:** Bun 1.4, Hono 4, `bun:sqlite`, `jose` 6 (Google ID tokens, APNs JWT), `markdown-it` 15, `node:http2`.
- **Apple:** Swift 6.2, SwiftUI, Swift Testing, XcodeGen 2.45, GoogleSignIn-iOS 9.x, iOS 18, macOS 15.
- **Deployment:** siteio (Docker app built from git, volume, secrets).

**Spec:** `docs/superpowers/specs/2026-10-02-pocket-pager-design.md`

## Global Constraints

- **Runtime and package manager:** Bun everywhere on the server (`bun add`, `bun test`, `bun run`). No npm, no Node runtime.
- **Host:** `https://pagerio.chuut.com` (`PUBLIC_BASE_URL`).
- **Bundle IDs:** iOS `com.chuut.pagerio`, macOS `com.chuut.pagerio.mac`. These are also the APNs topics.
- **Tokens and IDs:**
  - Trigger token, session token and `public_id`: 32 random bytes, base64url, exactly 43 characters.
  - Stored only as SHA-256 hashes, except the trigger token, which also has an AES-256-GCM copy under `TOKEN_ENC_KEY` (32 bytes, base64).
- **Trigger limits:**

  | Field | Limit |
  |---|---|
  | `title` | 100 code points |
  | `message` | 1,000 code points |
  | `details` | 10,000 code points |
  | `url` | 2,048 characters, `http`/`https` only |
  | `group` | 50 code points |
  | Body | 16,384 bytes |
  | `Idempotency-Key` | 200 characters, remembered for 24 hours |

  An empty message becomes `You've been paged.`
- **Rate limits:** 10 pages per minute and 100 per day per account, counted from the `pages` table. 30 trigger requests per minute per IP, in memory. All three are configurable.
- **Trigger responses:**
  - Success: `202 {id, status:"accepted", view_url}`.
  - Errors: `{error:{code,message}}` with `400 invalid_input`, `404 not_found`, `405 method_not_allowed`, `413 payload_too_large`, `429 rate_limited` (with `Retry-After`) or `500 internal`.
- **APNs:**
  - Headers: `apns-push-type: alert`, `apns-priority: 10`, `apns-expiration` = page creation time + 3,600 s.
  - Payload: sound `pager.caf`, `interruption-level: time-sensitive`, `thread-id` = `group` or `pages`. `category: PAGE_WITH_LINK` only when `url` is set.
  - Retry delays: 5 s, 30 s, 120 s, 600 s, then `failed`.
- **Retention:** pages older than 30 days are never returned by any route. Physical deletion comes in phase 4. Sessions idle for 90 days are rejected.
- **Logging:** never log message content, trigger tokens, session tokens or `public_id` values. Paths are logged as `/p/***` and `/v/***`.
- **Web security:**
  - CSP: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'`.
  - Every response also sends `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY`.
- **Tests:** adversarial cases first (this is the user's standing rule). Server tests use `bun test`; PagerKit tests use Swift Testing through `swift test`.
- **Commits:** end every commit message with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_014UQcaHgdRseLJWcr1Q54Ec
  ```
  The commit commands below omit these lines for brevity. Add them every time.

**Deliberate deviations from the spec** (they keep the spec's intent):
1. `SESSION_COOKIE_SECRET` is not used. Cookies carry opaque session tokens, and the CSRF token is derived from the session token, so no signing secret is needed.
2. Idempotency is enforced inside the `createPage` transaction with a 24-hour lookup, not a `UNIQUE` constraint, so a key can be reused after 24 hours.
3. `url` is capped at 2,048 characters, and the notification body is truncated to keep the APNs payload under 4 KB.
4. App sign-out deletes that device, so a signed-out phone stops receiving pages.
5. `APNS_KEY_P8` accepts the PEM text or its base64 encoding, so it fits in a one-line env file.

## Review Focus

These are the five failure modes most likely to bite a real user that the spec doesn't spell out. Each one has a test in the task named.

1. **A message of 1,000 emoji plus a 2,048-character URL.** APNs rejects payloads over 4 KB, so the page would silently never arrive. Expected: the notification arrives with a truncated body ending in `…`. *(Task 2: `buildPayload` stays ≤ 4,096 bytes; Task 10: URL length cap.)*
2. **Signing out of the app, or a second person signing into the same phone.** Expected: the old account no longer pages that phone. *(Task 9: re-registering a token moves it; Task 14: logout removes the device.)*
3. **A caller sends a fake `X-Forwarded-For` to dodge the per-IP limit.** Expected: the limit still applies, because only the rightmost (proxy-added) address counts. *(Task 12.)*
4. **The server was down for hours and restarts with a backlog.** Expected: pages older than one hour are marked `expired`, not sent as a burst of stale alerts. *(Task 13.)*
5. **A device is removed (APNs `410`) while it still has queued jobs.** Expected: those jobs fail as `device_removed`, and the worker keeps running. *(Task 13.)*

---

## File Structure

```text
pagerio/
├── .gitignore
├── server/
│   ├── package.json, tsconfig.json, bunfig.toml, Dockerfile, .dockerignore
│   ├── migrations/001_init.sql            schema
│   ├── public/style.css, public/app.js    dashboard assets (no inline JS/CSS)
│   ├── scripts/send-push.ts               phase 1 raw-token push CLI
│   ├── src/
│   │   ├── index.ts                       process entry: loadConfig + startServer + signals
│   │   ├── server.ts                      startServer(): wires db, worker, sender, app, Bun.serve
│   │   ├── app.ts                         createApp(deps): middleware + route mounting
│   │   ├── config.ts                      env parsing (Config, loadConfig, loadApnsConfig)
│   │   ├── context.ts                     Ctx type {db, config, now}
│   │   ├── logging.ts                     JSON logger, path redaction, request logger
│   │   ├── auth/tokens.ts                 randomToken, hashToken, newId, encrypt/decrypt, constantTimeEqual
│   │   ├── auth/google.ts                 Google ID-token verifier
│   │   ├── auth/googleOAuth.ts            Google web OAuth code flow client
│   │   ├── db/database.ts                 openDatabase + migrations
│   │   ├── db/accounts.ts, sessions.ts, devices.ts, pages.ts, jobs.ts   all SQL
│   │   ├── services/accounts.ts           findOrCreateAccount, findAccountByTriggerToken, triggerUrl
│   │   ├── services/sessions.ts           createSession, resolveSession, revokeSession
│   │   ├── services/devices.ts            parseDeviceInput, registerCurrentDevice
│   │   ├── services/pageInput.ts          parseTriggerBody, LIMITS
│   │   ├── services/pages.ts              createPage, listPagesForAccount, viewUrl, TEST_PAGE_INPUT
│   │   ├── delivery/apns.ts               payload, classification, provider token, HTTP/2 sender
│   │   ├── delivery/worker.ts             DeliveryWorker
│   │   ├── api/responses.ts               errorJson, acceptedJson, rateLimitedJson
│   │   ├── api/ipLimiter.ts               FixedWindowLimiter, clientIp
│   │   ├── api/trigger.ts                 POST /p/:token
│   │   ├── api/appApi.ts                  /api/*
│   │   ├── web/http.ts                    securityHeaders, renderHtml
│   │   ├── web/session.ts                 cookies, CSRF
│   │   ├── web/layout.tsx                 HTML shell
│   │   ├── web/authRoutes.tsx             /auth/google, callback, logout
│   │   ├── web/dashboard.tsx              GET /, POST /test
│   │   ├── web/markdown.ts                safe Markdown rendering
│   │   └── web/publicView.tsx             GET /v/:publicId
│   └── test/ (mirrors src/, plus helpers.ts)
└── apple/
    ├── project.yml                        XcodeGen
    ├── Config/Base.xcconfig               shared build settings (Local.xcconfig ignored)
    ├── PagerKit/                          Swift package + tests
    ├── Shared/                            sources and resources compiled into both apps
    ├── iOSApp/
    └── MacApp/
```

---

# Phase 1 — Prove delivery

### Task 1: Server scaffold and configuration

**Files:**
- Create: `.gitignore`, `server/package.json` (via `bun init`/`bun add`), `server/tsconfig.json`, `server/bunfig.toml`
- Create: `server/src/config.ts`, `server/src/app.ts`, `server/src/index.ts`
- Test: `server/test/config.test.ts`, `server/test/app.test.ts`

**Interfaces:**
- Produces:
  - `type ApnsEnv = "sandbox" | "production"`, `type Platform = "ios" | "macos"`.
  - `interface ApnsConfig { keyP8: string; keyId: string; teamId: string; topics: Record<Platform, string> }`.
  - `interface GoogleConfig { webClientId; webClientSecret; iosClientId; macosClientId }` (all strings).
  - `interface Limits { pagesPerMinute; pagesPerDay; triggerRequestsPerIpPerMinute }` (all numbers).
  - `interface Config { port: number; publicBaseUrl: string; databasePath: string; tokenEncKey: Buffer; apns: ApnsConfig; google: GoogleConfig; limits: Limits }`.
  - `class ConfigError`.
  - `loadApnsConfig(env?): ApnsConfig` and `loadConfig(env?): Config`.
  - `createApp(): Hono` (gains a `deps` parameter in Task 12).

- [ ] **Step 1: Replace the repo-level `.gitignore`** (it already ignores `server/secrets.env`; keep that line)

```gitignore
.DS_Store
*.p8
server/node_modules/
server/.env
server/secrets.env
server/data/
apple/PocketPager.xcodeproj/
apple/Config/Local.xcconfig
apple/PagerKit/.build/
apple/build/
xcuserdata/
```

- [ ] **Step 2: Scaffold the Bun project**

```bash
mkdir -p server && cd server
bun init -y
rm -f index.ts README.md
bun add hono jose markdown-it
bun add -d @types/bun @types/markdown-it typescript
```

Then replace the `scripts` section of `server/package.json` with:

```json
"scripts": {
  "dev": "bun --watch src/index.ts",
  "start": "bun src/index.ts",
  "test": "bun test",
  "typecheck": "tsc --noEmit",
  "send-push": "bun scripts/send-push.ts"
}
```

Write `server/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "jsxImportSource": "hono/jsx",
    "types": ["bun"]
  },
  "include": ["src", "scripts", "test"]
}
```

Write `server/bunfig.toml`:

```toml
[test]
root = "./test"
```

- [ ] **Step 3: Write the failing config tests** (`server/test/config.test.ts`)

```ts
import { describe, expect, test } from "bun:test";
import { ConfigError, loadApnsConfig, loadConfig } from "../src/config";

const PEM = "-----BEGIN PRIVATE KEY-----\nMIGT\n-----END PRIVATE KEY-----";

function validEnv(): Record<string, string> {
  return {
    PUBLIC_BASE_URL: "https://pagerio.chuut.com/",
    TOKEN_ENC_KEY: Buffer.alloc(32, 1).toString("base64"),
    APNS_KEY_P8: PEM,
    APNS_KEY_ID: "KEY123",
    APNS_TEAM_ID: "TEAM123",
    GOOGLE_CLIENT_ID_WEB: "web",
    GOOGLE_CLIENT_SECRET_WEB: "secret",
    GOOGLE_CLIENT_ID_IOS: "ios",
    GOOGLE_CLIENT_ID_MACOS: "mac",
  };
}

describe("loadConfig", () => {
  test("parses a complete environment with defaults", () => {
    const config = loadConfig(validEnv());
    expect(config.publicBaseUrl).toBe("https://pagerio.chuut.com");
    expect(config.port).toBe(3000);
    expect(config.databasePath).toBe("/data/pagerio.db");
    expect(config.tokenEncKey.length).toBe(32);
    expect(config.apns.topics).toEqual({ ios: "com.chuut.pagerio", macos: "com.chuut.pagerio.mac" });
    expect(config.limits).toEqual({ pagesPerMinute: 10, pagesPerDay: 100, triggerRequestsPerIpPerMinute: 30 });
  });

  for (const name of Object.keys(validEnv())) {
    test(`fails clearly when ${name} is missing`, () => {
      const env = validEnv();
      delete env[name];
      expect(() => loadConfig(env)).toThrow(name);
    });
  }

  test("treats a whitespace-only value as missing", () => {
    expect(() => loadConfig({ ...validEnv(), APNS_KEY_ID: "   " })).toThrow("APNS_KEY_ID");
  });

  test("rejects an encryption key that is not 32 bytes", () => {
    const env = { ...validEnv(), TOKEN_ENC_KEY: Buffer.alloc(16, 1).toString("base64") };
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  test("rejects a base URL that is not http(s)", () => {
    expect(() => loadConfig({ ...validEnv(), PUBLIC_BASE_URL: "ftp://x" })).toThrow("PUBLIC_BASE_URL");
    expect(() => loadConfig({ ...validEnv(), PUBLIC_BASE_URL: "not a url" })).toThrow("PUBLIC_BASE_URL");
  });

  test("rejects non-integer, zero and negative limits", () => {
    for (const bad of ["abc", "0", "-5", "1.5"]) {
      expect(() => loadConfig({ ...validEnv(), PAGES_PER_MINUTE: bad })).toThrow("PAGES_PER_MINUTE");
    }
  });

  test("accepts overridden limits, port and topics", () => {
    const config = loadConfig({
      ...validEnv(),
      PORT: "8080",
      PAGES_PER_MINUTE: "3",
      PAGES_PER_DAY: "7",
      TRIGGER_REQUESTS_PER_IP_PER_MINUTE: "9",
      APNS_TOPIC_IOS: "a.b",
      APNS_TOPIC_MACOS: "a.c",
    });
    expect(config.port).toBe(8080);
    expect(config.limits).toEqual({ pagesPerMinute: 3, pagesPerDay: 7, triggerRequestsPerIpPerMinute: 9 });
    expect(config.apns.topics).toEqual({ ios: "a.b", macos: "a.c" });
  });
});

describe("loadApnsConfig", () => {
  const base = { APNS_KEY_ID: "K", APNS_TEAM_ID: "T" };

  test("accepts a PEM key with escaped newlines", () => {
    const config = loadApnsConfig({ ...base, APNS_KEY_P8: PEM.replaceAll("\n", "\\n") });
    expect(config.keyP8).toBe(PEM);
  });

  test("accepts a base64-encoded PEM key", () => {
    const config = loadApnsConfig({ ...base, APNS_KEY_P8: Buffer.from(PEM).toString("base64") });
    expect(config.keyP8).toBe(PEM);
  });

  test("rejects a value that is neither PEM nor base64 PEM", () => {
    expect(() => loadApnsConfig({ ...base, APNS_KEY_P8: "hello" })).toThrow("APNS_KEY_P8");
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd server && bun test test/config.test.ts`
Expected: FAIL with "Cannot find module '../src/config'".

- [ ] **Step 5: Implement `server/src/config.ts`**

```ts
export type ApnsEnv = "sandbox" | "production";
export type Platform = "ios" | "macos";

export interface ApnsConfig {
  keyP8: string;
  keyId: string;
  teamId: string;
  topics: Record<Platform, string>;
}

export interface GoogleConfig {
  webClientId: string;
  webClientSecret: string;
  iosClientId: string;
  macosClientId: string;
}

export interface Limits {
  pagesPerMinute: number;
  pagesPerDay: number;
  triggerRequestsPerIpPerMinute: number;
}

export interface Config {
  port: number;
  publicBaseUrl: string;
  databasePath: string;
  tokenEncKey: Buffer;
  apns: ApnsConfig;
  google: GoogleConfig;
  limits: Limits;
}

type Env = Record<string, string | undefined>;

export class ConfigError extends Error {}

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`Missing required environment variable ${name}`);
  return value;
}

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new ConfigError(`${name} must be a positive integer`);
  return value;
}

function decodeP8(raw: string): string {
  const unescaped = raw.replaceAll("\\n", "\n");
  if (unescaped.includes("BEGIN PRIVATE KEY")) return unescaped;
  const decoded = Buffer.from(raw, "base64").toString("utf8");
  if (decoded.includes("BEGIN PRIVATE KEY")) return decoded;
  throw new ConfigError("APNS_KEY_P8 must be a PEM private key or its base64 encoding");
}

function baseUrl(env: Env): string {
  const raw = required(env, "PUBLIC_BASE_URL").replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("PUBLIC_BASE_URL must be an http(s) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError("PUBLIC_BASE_URL must be an http(s) URL");
  }
  return raw;
}

export function loadApnsConfig(env: Env = process.env): ApnsConfig {
  return {
    keyP8: decodeP8(required(env, "APNS_KEY_P8")),
    keyId: required(env, "APNS_KEY_ID"),
    teamId: required(env, "APNS_TEAM_ID"),
    topics: {
      ios: env.APNS_TOPIC_IOS?.trim() || "com.chuut.pagerio",
      macos: env.APNS_TOPIC_MACOS?.trim() || "com.chuut.pagerio.mac",
    },
  };
}

export function loadConfig(env: Env = process.env): Config {
  const tokenEncKey = Buffer.from(required(env, "TOKEN_ENC_KEY"), "base64");
  if (tokenEncKey.length !== 32) throw new ConfigError("TOKEN_ENC_KEY must be 32 bytes, base64-encoded");
  return {
    port: positiveInt(env, "PORT", 3000),
    publicBaseUrl: baseUrl(env),
    databasePath: env.DATABASE_PATH?.trim() || "/data/pagerio.db",
    tokenEncKey,
    apns: loadApnsConfig(env),
    google: {
      webClientId: required(env, "GOOGLE_CLIENT_ID_WEB"),
      webClientSecret: required(env, "GOOGLE_CLIENT_SECRET_WEB"),
      iosClientId: required(env, "GOOGLE_CLIENT_ID_IOS"),
      macosClientId: required(env, "GOOGLE_CLIENT_ID_MACOS"),
    },
    limits: {
      pagesPerMinute: positiveInt(env, "PAGES_PER_MINUTE", 10),
      pagesPerDay: positiveInt(env, "PAGES_PER_DAY", 100),
      triggerRequestsPerIpPerMinute: positiveInt(env, "TRIGGER_REQUESTS_PER_IP_PER_MINUTE", 30),
    },
  };
}
```

- [ ] **Step 6: Write the failing app test** (`server/test/app.test.ts`)

```ts
import { expect, test } from "bun:test";
import { createApp } from "../src/app";

test("GET /healthz answers ok", async () => {
  const res = await createApp().request("/healthz");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test("unknown routes are 404", async () => {
  const res = await createApp().request("/nope");
  expect(res.status).toBe(404);
});
```

- [ ] **Step 7: Implement `server/src/app.ts` and `server/src/index.ts`**

```ts
// server/src/app.ts
import { Hono } from "hono";

export function createApp(): Hono {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true }));
  return app;
}
```

```ts
// server/src/index.ts
import { createApp } from "./app";

const port = Number(process.env.PORT ?? 3000);
Bun.serve({ port, fetch: createApp().fetch });
console.log(JSON.stringify({ event: "server_started", port }));
```

- [ ] **Step 8: Run all tests and the type check**

Run: `cd server && bun test && bun run typecheck`
Expected: all tests PASS, and `tsc` reports no errors.

- [ ] **Step 9: Commit**

```bash
git add .gitignore server
git commit -m "feat(server): scaffold Bun + Hono server with validated configuration"
```

---

### Task 2: APNs sender and `send-push` script

**Files:**
- Create: `server/src/delivery/apns.ts`, `server/scripts/send-push.ts`
- Test: `server/test/delivery/apns.test.ts`

**Interfaces:**
- Consumes: `ApnsConfig`, `ApnsEnv`, `Platform` from `src/config.ts`.
- Produces:
  - `interface ApnsTarget { token: string; env: ApnsEnv; platform: Platform }`.
  - `interface ApnsMessage { title: string | null; body: string; threadId: string; publicId: string | null; viewUrl: string | null; url: string | null; expiresAtSeconds: number }`.
  - `type ApnsResult = { kind: "ok"; apnsId: string } | { kind: "invalid-token"; reason: string } | { kind: "retry"; reason: string } | { kind: "fail"; reason: string }`.
  - `interface ApnsSender { send(target: ApnsTarget, message: ApnsMessage): Promise<ApnsResult>; close(): void }`.
  - `buildPayload(m: ApnsMessage): string`.
  - `classifyResponse(status: number, body: string, apnsId: string | undefined): ApnsResult`.
  - `class ProviderTokenCache`.
  - `createApnsSender(config: ApnsConfig, options?: { hosts?: Record<ApnsEnv, string>; timeoutMs?: number; now?: () => number }): ApnsSender`.
  - Constants `MAX_PAYLOAD_BYTES = 4096` and `APNS_HOSTS`.

- [ ] **Step 1: Write the failing tests** (`server/test/delivery/apns.test.ts`)

```ts
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
  test("410 and BadDeviceToken mean the token is dead", () => {
    expect(classifyResponse(410, '{"reason":"Unregistered"}', undefined)).toEqual({ kind: "invalid-token", reason: "Unregistered" });
    expect(classifyResponse(400, '{"reason":"BadDeviceToken"}', undefined).kind).toBe("invalid-token");
  });
  test("other 400s are permanent failures, not token deletions", () => {
    expect(classifyResponse(400, '{"reason":"DeviceTokenNotForTopic"}', undefined)).toEqual({ kind: "fail", reason: "DeviceTokenNotForTopic" });
    expect(classifyResponse(413, '{"reason":"PayloadTooLarge"}', undefined).kind).toBe("fail");
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
    server.on("stream", (stream, headers) => {
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
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && bun test test/delivery/apns.test.ts`
Expected: FAIL with "Cannot find module '../../src/delivery/apns'".

- [ ] **Step 3: Implement `server/src/delivery/apns.ts`**

```ts
import http2 from "node:http2";
import { importPKCS8, SignJWT } from "jose";
import type { ApnsConfig, ApnsEnv, Platform } from "../config";

export const APNS_HOSTS: Record<ApnsEnv, string> = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};
export const MAX_PAYLOAD_BYTES = 4096;
const PAYLOAD_BUDGET_BYTES = 4000;
const PROVIDER_TOKEN_TTL_MS = 50 * 60 * 1000;
const MAX_REASON_LENGTH = 200;

export interface ApnsTarget {
  token: string;
  env: ApnsEnv;
  platform: Platform;
}

export interface ApnsMessage {
  title: string | null;
  body: string;
  threadId: string;
  publicId: string | null;
  viewUrl: string | null;
  url: string | null;
  expiresAtSeconds: number;
}

export type ApnsResult =
  | { kind: "ok"; apnsId: string }
  | { kind: "invalid-token"; reason: string }
  | { kind: "retry"; reason: string }
  | { kind: "fail"; reason: string };

export interface ApnsSender {
  send(target: ApnsTarget, message: ApnsMessage): Promise<ApnsResult>;
  close(): void;
}

const encoder = new TextEncoder();
const byteLength = (s: string) => encoder.encode(s).length;
// Bytes a string contributes inside a JSON string literal (escaping is per character).
const jsonBytes = (s: string) => byteLength(JSON.stringify(s)) - 2;

function truncateForJson(text: string, maxBytes: number): string {
  if (jsonBytes(text) <= maxBytes) return text;
  const ellipsis = "…";
  const budget = maxBytes - jsonBytes(ellipsis);
  if (budget <= 0) return "";
  let out = "";
  let used = 0;
  for (const ch of text) {
    const size = jsonBytes(ch);
    if (used + size > budget) break;
    out += ch;
    used += size;
  }
  return out + ellipsis;
}

export function buildPayload(m: ApnsMessage): string {
  const alert: { title?: string; body: string } = m.title ? { title: m.title, body: "" } : { body: "" };
  const aps: Record<string, unknown> = {
    alert,
    sound: "pager.caf",
    "interruption-level": "time-sensitive",
    "thread-id": m.threadId,
  };
  if (m.url) aps.category = "PAGE_WITH_LINK";
  const payload: Record<string, unknown> = { aps };
  if (m.publicId) payload.public_id = m.publicId;
  if (m.viewUrl) payload.view_url = m.viewUrl;
  if (m.url) payload.url = m.url;
  const remaining = PAYLOAD_BUDGET_BYTES - byteLength(JSON.stringify(payload));
  alert.body = truncateForJson(m.body, remaining);
  return JSON.stringify(payload);
}

export function classifyResponse(status: number, body: string, apnsId: string | undefined): ApnsResult {
  if (status === 200) return { kind: "ok", apnsId: apnsId ?? "" };
  let reason = `HTTP ${status}`;
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    if (typeof parsed.reason === "string" && parsed.reason) reason = parsed.reason.slice(0, MAX_REASON_LENGTH);
  } catch {
    // Non-JSON body: keep the HTTP status as the reason.
  }
  if (status === 410 || (status === 400 && reason === "BadDeviceToken")) return { kind: "invalid-token", reason };
  if (status === 429 || status >= 500 || (status === 403 && reason === "ExpiredProviderToken")) return { kind: "retry", reason };
  return { kind: "fail", reason };
}

export class ProviderTokenCache {
  private token: string | null = null;
  private issuedAt = 0;

  constructor(
    private readonly sign: (issuedAtSeconds: number) => Promise<string>,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<string> {
    const now = this.now();
    if (this.token === null || now - this.issuedAt >= PROVIDER_TOKEN_TTL_MS) {
      this.token = await this.sign(Math.floor(now / 1000));
      this.issuedAt = now;
    }
    return this.token;
  }

  invalidate(): void {
    this.token = null;
  }
}

export interface ApnsSenderOptions {
  hosts?: Record<ApnsEnv, string>;
  timeoutMs?: number;
  now?: () => number;
}

export function createApnsSender(config: ApnsConfig, options: ApnsSenderOptions = {}): ApnsSender {
  const hosts = options.hosts ?? APNS_HOSTS;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const keyPromise = importPKCS8(config.keyP8, "ES256");
  const tokens = new ProviderTokenCache(
    async (iat) =>
      new SignJWT({})
        .setProtectedHeader({ alg: "ES256", kid: config.keyId })
        .setIssuer(config.teamId)
        .setIssuedAt(iat)
        .sign(await keyPromise),
    options.now,
  );
  const sessions = new Map<string, http2.ClientHttp2Session>();

  function sessionFor(origin: string): http2.ClientHttp2Session {
    const existing = sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const created = http2.connect(origin);
    const forget = () => {
      if (sessions.get(origin) === created) sessions.delete(origin);
    };
    created.on("error", forget);
    created.on("close", forget);
    created.on("goaway", forget);
    sessions.set(origin, created);
    return created;
  }

  async function send(target: ApnsTarget, message: ApnsMessage): Promise<ApnsResult> {
    if (!/^[0-9a-f]+$/i.test(target.token)) return { kind: "invalid-token", reason: "malformed_token" };
    let authorization: string;
    try {
      authorization = `bearer ${await tokens.get()}`;
    } catch {
      return { kind: "fail", reason: "provider_token_error" };
    }
    const body = buildPayload(message);

    return new Promise<ApnsResult>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (result: ApnsResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      let request: http2.ClientHttp2Stream;
      try {
        request = sessionFor(hosts[target.env]).request({
          ":method": "POST",
          ":path": `/3/device/${target.token}`,
          authorization,
          "apns-topic": config.topics[target.platform],
          "apns-push-type": "alert",
          "apns-priority": "10",
          "apns-expiration": String(message.expiresAtSeconds),
          "content-type": "application/json",
        });
      } catch {
        finish({ kind: "retry", reason: "connection_error" });
        return;
      }

      timer = setTimeout(() => {
        request.close(http2.constants.NGHTTP2_CANCEL);
        finish({ kind: "retry", reason: "timeout" });
      }, timeoutMs);

      let status = 0;
      let apnsId: string | undefined;
      let data = "";
      request.setEncoding("utf8");
      request.on("response", (headers) => {
        status = Number(headers[":status"]);
        const id = headers["apns-id"];
        apnsId = typeof id === "string" ? id : undefined;
      });
      request.on("data", (chunk: string) => {
        data += chunk;
      });
      request.on("end", () => {
        const result = classifyResponse(status, data, apnsId);
        if (result.kind === "retry" && result.reason === "ExpiredProviderToken") tokens.invalidate();
        finish(result);
      });
      request.on("error", () => finish({ kind: "retry", reason: "network_error" }));
      request.end(body);
    });
  }

  return {
    send,
    close() {
      for (const session of sessions.values()) session.close();
      sessions.clear();
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && bun test test/delivery/apns.test.ts`
Expected: PASS (all `buildPayload`, `classifyResponse`, `ProviderTokenCache` and local HTTP/2 server tests).

- [ ] **Step 5: Write the phase 1 CLI** (`server/scripts/send-push.ts`)

```ts
// Phase 1 helper: send one notification to a raw device token.
// Usage: bun run send-push --token <hex> [--platform ios|macos] [--env sandbox|production] [--title T] [--message M]
// Reads APNS_KEY_P8, APNS_KEY_ID, APNS_TEAM_ID (and optional APNS_TOPIC_*) from server/.env.
import { parseArgs } from "node:util";
import { loadApnsConfig, type ApnsEnv, type Platform } from "../src/config";
import { createApnsSender } from "../src/delivery/apns";

const { values } = parseArgs({
  options: {
    token: { type: "string" },
    platform: { type: "string", default: "ios" },
    env: { type: "string", default: "sandbox" },
    title: { type: "string" },
    message: { type: "string", default: "You've been paged." },
  },
});

if (!values.token) throw new Error("--token is required");
if (values.platform !== "ios" && values.platform !== "macos") throw new Error("--platform must be ios or macos");
if (values.env !== "sandbox" && values.env !== "production") throw new Error("--env must be sandbox or production");

const sender = createApnsSender(loadApnsConfig());
const result = await sender.send(
  { token: values.token, platform: values.platform as Platform, env: values.env as ApnsEnv },
  {
    title: values.title ?? null,
    body: values.message!,
    threadId: "pages",
    publicId: null,
    viewUrl: null,
    url: null,
    expiresAtSeconds: Math.floor(Date.now() / 1000) + 3600,
  },
);
console.log(JSON.stringify(result));
sender.close();
process.exit(result.kind === "ok" ? 0 : 1);
```

- [ ] **Step 6: Run the full suite and the type check**

Run: `cd server && bun test && bun run typecheck`
Expected: PASS, with no type errors.

- [ ] **Step 7: Commit**

```bash
git add server
git commit -m "feat(server): APNs HTTP/2 sender with payload budget, classification and send-push CLI"
```

---

### Task 3: Apple project scaffold that shows the device token

**Files:**
- Create: `apple/project.yml`, `apple/Config/Base.xcconfig`
- Create: `apple/PagerKit/Package.swift`, `apple/PagerKit/Sources/PagerKit/ApnsEnvironment.swift`, `DeviceToken.swift`, `DeviceModel.swift`
- Test: `apple/PagerKit/Tests/PagerKitTests/DeviceTokenTests.swift`
- Create: `apple/Shared/BuildEnvironment.swift`, `apple/Shared/Clipboard.swift`, `apple/Shared/PushTokenModel.swift`, `apple/Shared/PushTokenView.swift`, `apple/Shared/pager.caf`
- Create: `apple/iOSApp/PocketPagerApp.swift`, `apple/iOSApp/AppDelegate.swift`
- Create: `apple/MacApp/PocketPagerMacApp.swift`, `apple/MacApp/AppDelegate.swift`

**Interfaces:**
- Produces (PagerKit):
  - `enum ApnsEnvironment: String { sandbox, production }`.
  - `enum DevicePlatform: String { ios, macos; static var current }`.
  - `enum DeviceToken { static func hex(_ data: Data) -> String }`.
  - `enum DeviceModel { static var current: String }`.
- Produces (Shared, app targets only): `extension ApnsEnvironment { static var current }`, which is `.sandbox` in Debug and `.production` otherwise.

- [ ] **Step 1: Write the PagerKit package and failing test**

`apple/PagerKit/Package.swift`:

```swift
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PagerKit",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [.library(name: "PagerKit", targets: ["PagerKit"])],
    targets: [
        .target(name: "PagerKit"),
        .testTarget(name: "PagerKitTests", dependencies: ["PagerKit"]),
    ]
)
```

`apple/PagerKit/Tests/PagerKitTests/DeviceTokenTests.swift`:

```swift
import Foundation
import Testing
@testable import PagerKit

@Suite struct DeviceTokenTests {
    @Test func hexEncodesEveryByteWithLeadingZeros() {
        #expect(DeviceToken.hex(Data([0x00, 0x0a, 0xab, 0xff])) == "000aabff")
    }

    @Test func emptyDataGivesEmptyString() {
        #expect(DeviceToken.hex(Data()) == "")
    }

    @Test func modelIsNeverEmpty() {
        #expect(!DeviceModel.current.isEmpty)
        #expect(!DeviceModel.current.contains("\0"))
    }

    @Test func platformMatchesTheHost() {
        #expect(DevicePlatform.current == .macos) // swift test runs on macOS
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apple/PagerKit && swift test`
Expected: FAIL to compile with "cannot find 'DeviceToken' in scope".

- [ ] **Step 3: Implement the PagerKit sources**

`apple/PagerKit/Sources/PagerKit/ApnsEnvironment.swift`:

```swift
public enum ApnsEnvironment: String, Sendable, Codable {
    case sandbox
    case production
}

public enum DevicePlatform: String, Sendable, Codable {
    case ios
    case macos

    public static var current: DevicePlatform {
        #if os(macOS)
        .macos
        #else
        .ios
        #endif
    }
}
```

`apple/PagerKit/Sources/PagerKit/DeviceToken.swift`:

```swift
import Foundation

public enum DeviceToken {
    public static func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }
}
```

`apple/PagerKit/Sources/PagerKit/DeviceModel.swift`:

```swift
import Foundation

/// Hardware model identifier such as "iPhone17,1" or "Mac15,3".
public enum DeviceModel {
    public static var current: String {
        #if os(macOS)
        var size = 0
        sysctlbyname("hw.model", nil, &size, nil, 0)
        guard size > 0 else { return "Mac" }
        var buffer = [UInt8](repeating: 0, count: size)
        sysctlbyname("hw.model", &buffer, &size, nil, 0)
        let model = String(decoding: buffer.prefix { $0 != 0 }, as: UTF8.self)
        return model.isEmpty ? "Mac" : model
        #else
        var info = utsname()
        uname(&info)
        let bytes = withUnsafeBytes(of: info.machine) { Array($0.prefix { $0 != 0 }) }
        let model = String(decoding: bytes, as: UTF8.self)
        return model.isEmpty ? "iPhone" : model
        #endif
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apple/PagerKit && swift test`
Expected: PASS (4 tests).

- [ ] **Step 5: Add the shared app sources and sound**

`apple/Shared/BuildEnvironment.swift`:

```swift
import PagerKit

extension ApnsEnvironment {
    /// Debug builds run from Xcode use the APNs sandbox; archived (TestFlight) builds use production.
    static var current: ApnsEnvironment {
        #if DEBUG
        .sandbox
        #else
        .production
        #endif
    }
}
```

`apple/Shared/Clipboard.swift`:

```swift
#if os(macOS)
import AppKit
#else
import UIKit
#endif

enum Clipboard {
    static func copy(_ text: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #else
        UIPasteboard.general.string = text
        #endif
    }
}
```

`apple/Shared/PushTokenModel.swift`:

```swift
import Observation

/// Phase 1 only: holds the APNs token so it can be copied into `bun run send-push`.
@MainActor @Observable
final class PushTokenModel {
    var hex: String?
    var error: String?
}
```

`apple/Shared/PushTokenView.swift`:

```swift
import PagerKit
import SwiftUI

struct PushTokenView: View {
    let model: PushTokenModel

    var body: some View {
        VStack(spacing: 12) {
            Text("Pocket Pager").font(.title2.bold())
            Text("APNs environment: \(ApnsEnvironment.current.rawValue)")
                .foregroundStyle(.secondary)
            if let hex = model.hex {
                Text(hex)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                Button("Copy token") { Clipboard.copy(hex) }
                    .buttonStyle(.borderedProminent)
            } else if let error = model.error {
                Text(error).foregroundStyle(.red)
            } else {
                ProgressView("Registering for notifications…")
            }
        }
        .padding()
    }
}
```

Create the placeholder sound:

```bash
mkdir -p apple/Shared
afconvert -f caff -d LEI16 /System/Library/Sounds/Glass.aiff apple/Shared/pager.caf
```

- [ ] **Step 6: Add the iOS app**

`apple/iOSApp/AppDelegate.swift`:

```swift
import PagerKit
import UIKit
import UserNotifications

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    @MainActor let push = PushTokenModel()

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        Task {
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
            application.registerForRemoteNotifications()
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = DeviceToken.hex(deviceToken)
        print("APNs token: \(hex)")
        push.hex = hex
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        push.error = error.localizedDescription
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }
}
```

`apple/iOSApp/PocketPagerApp.swift`:

```swift
import SwiftUI

@main
struct PocketPagerApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            PushTokenView(model: appDelegate.push)
        }
    }
}
```

- [ ] **Step 7: Add the macOS app**

`apple/MacApp/AppDelegate.swift`:

```swift
import AppKit
import PagerKit
import UserNotifications

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    @MainActor let push = PushTokenModel()

    func applicationDidFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = self
        Task {
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
            NSApplication.shared.registerForRemoteNotifications()
        }
    }

    func application(_ application: NSApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = DeviceToken.hex(deviceToken)
        print("APNs token: \(hex)")
        push.hex = hex
    }

    func application(_ application: NSApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        push.error = error.localizedDescription
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }
}
```

`apple/MacApp/PocketPagerMacApp.swift`:

```swift
import SwiftUI

@main
struct PocketPagerMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        MenuBarExtra("Pocket Pager", systemImage: "dot.radiowaves.left.and.right") {
            PushTokenView(model: appDelegate.push)
                .frame(width: 340)
        }
        .menuBarExtraStyle(.window)
    }
}
```

- [ ] **Step 8: Write the XcodeGen project and build settings**

`apple/Config/Base.xcconfig`:

```
// Shared build settings. The team ID is not a secret (it is in every signed app).
DEVELOPMENT_TEAM = 427N276E3Q
PAGERIO_API_BASE_URL = https:/$()/pagerio.chuut.com
// Optional per-machine overrides, git-ignored.
#include? "Local.xcconfig"
```

`apple/project.yml`:

```yaml
name: PocketPager
options:
  bundleIdPrefix: com.chuut
  createIntermediateGroups: true
  deploymentTarget:
    iOS: "18.0"
    macOS: "15.0"
configFiles:
  Debug: Config/Base.xcconfig
  Release: Config/Base.xcconfig
settings:
  base:
    SWIFT_VERSION: "6.0"
    MARKETING_VERSION: "0.1.0"
    CURRENT_PROJECT_VERSION: "1"
    CODE_SIGN_STYLE: Automatic
packages:
  PagerKit:
    path: PagerKit
targets:
  PocketPager-iOS:
    type: application
    platform: iOS
    sources:
      - iOSApp
      - Shared
    dependencies:
      - package: PagerKit
    info:
      path: iOSApp/Info.plist
      properties:
        CFBundleDisplayName: Pocket Pager
        UILaunchScreen: {}
        UIBackgroundModes: [remote-notification]
        PagerioAPIBaseURL: $(PAGERIO_API_BASE_URL)
    entitlements:
      path: iOSApp/PocketPager-iOS.entitlements
      properties:
        aps-environment: development
        com.apple.developer.usernotifications.time-sensitive: true
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: com.chuut.pagerio
        PRODUCT_NAME: Pocket Pager
        TARGETED_DEVICE_FAMILY: "1"
  PocketPager-macOS:
    type: application
    platform: macOS
    sources:
      - MacApp
      - Shared
    dependencies:
      - package: PagerKit
    info:
      path: MacApp/Info.plist
      properties:
        CFBundleDisplayName: Pocket Pager
        LSUIElement: true
        PagerioAPIBaseURL: $(PAGERIO_API_BASE_URL)
    entitlements:
      path: MacApp/PocketPager-macOS.entitlements
      properties:
        com.apple.developer.aps-environment: development
        com.apple.developer.usernotifications.time-sensitive: true
        com.apple.security.app-sandbox: true
        com.apple.security.network.client: true
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: com.chuut.pagerio.mac
        PRODUCT_NAME: Pocket Pager
```

- [ ] **Step 9: Generate and build both apps without signing**

Run:
```bash
cd apple && xcodegen generate
xcodebuild -project PocketPager.xcodeproj -scheme PocketPager-iOS -destination 'generic/platform=iOS Simulator' build CODE_SIGNING_ALLOWED=NO -quiet
xcodebuild -project PocketPager.xcodeproj -scheme PocketPager-macOS -destination 'platform=macOS' build CODE_SIGNING_ALLOWED=NO -quiet
```
Expected: both builds succeed. If Swift 6 strict concurrency reports a delegate isolation error, mark the delegate class `@MainActor` and its conformance `@preconcurrency UNUserNotificationCenterDelegate`, and rebuild.

- [ ] **Step 10: Commit**

```bash
git add apple
git commit -m "feat(apple): XcodeGen project, PagerKit basics, apps that display their APNs token"
```

---

### Task 4: Phase 1 milestone — real-device delivery (manual)

This task is done by hand with the user. Nothing is committed unless a fix is needed.

- [ ] **Step 1: Apple Developer setup** (Team ID `427N276E3Q`; `asc` is already authenticated on this Mac)

Create both App IDs and turn on push and Time Sensitive notifications:

```bash
asc bundle-ids create --identifier com.chuut.pagerio --name "Pocket Pager" --platform IOS
asc bundle-ids create --identifier com.chuut.pagerio.mac --name "Pocket Pager Mac" --platform MAC_OS
for id in com.chuut.pagerio com.chuut.pagerio.mac; do
  asc bundle-ids capabilities add --bundle "$id" --capability PUSH_NOTIFICATIONS
  asc bundle-ids capabilities add --bundle "$id" --capability USERNOTIFICATIONS_TIMESENSITIVE
  asc bundle-ids capabilities list --bundle "$id"
done
```

If `asc` rejects a capability name, enable it on the App ID page in the portal instead. Xcode's automatic signing also adds missing capabilities on the first device build.

The App Store Connect API cannot create APNs keys. In the Apple Developer portal, under **Certificates, IDs & Profiles › Keys**, create a key with **Apple Push Notifications service (APNs)** enabled (by computer use or by the user), then download `AuthKey_<KEYID>.p8` once and note the Key ID. Keep the file outside the repo, for example in `~/.config/pagerio/`, and never commit it.

- [ ] **Step 2: Local configuration**

```bash
cd server
cat > .env <<EOF
APNS_KEY_P8=$(base64 -i ~/.config/pagerio/AuthKey_<KEYID>.p8)
APNS_KEY_ID=<KEYID>
APNS_TEAM_ID=427N276E3Q
EOF
cd ../apple && xcodegen generate && open PocketPager.xcodeproj
```

- [ ] **Step 3: iPhone.** In Xcode, select **PocketPager-iOS**, pick the connected iPhone and press Run. Allow notifications, then tap **Copy token** and paste it to the Mac (Universal Clipboard), or read it from the Xcode console.

```bash
cd server && bun run send-push --platform ios --env sandbox --token <IPHONE_HEX> --title "Pocket Pager" --message "Phase 1 works"
```

Expected: the script prints `{"kind":"ok","apnsId":"…"}` and the iPhone plays the Glass sound with the banner.

- [ ] **Step 4: Mac.** Run **PocketPager-macOS** from Xcode. Allow notifications, open the menu-bar icon, and copy the token.

```bash
cd server && bun run send-push --platform macos --env sandbox --token <MAC_HEX> --message "Phase 1 works on Mac"
```

Expected: `{"kind":"ok",…}` and a banner with the sound on the Mac.

- [ ] **Step 5: Real-device checklist.** For each case, send a push and note the result:
  - iPhone locked.
  - iPhone app killed (swiped away).
  - Focus on, with Time Sensitive allowed.
  - Focus on, with Time Sensitive turned off for the app.
  - Mac app quit.
  - Mac asleep, then woken.

Report the results to the user before starting phase 2. Delivery to a killed app or a quit Mac app must still work, because APNs, not the app, delivers the alert.

---

# Phase 2 — Complete the loop (server)

### Task 5: Database, migrations and test helpers

**Files:**
- Create: `server/migrations/001_init.sql`, `server/src/db/database.ts`, `server/src/context.ts`, `server/test/helpers.ts`
- Test: `server/test/db/database.test.ts`

**Interfaces:**
- Produces:
  - `openDatabase(path: string, migrationsDir?: string): Database`, which enables WAL and foreign keys and applies migrations.
  - `migrate(db, dir): number[]`, which returns the versions applied by this call.
  - `interface Ctx { db: Database; config: Config; now: () => number }`.
- Test helpers:
  - `T0`.
  - `class FakeClock { t; now(): number; advance(ms) }`.
  - `testConfig(overrides?): Config`.
  - `testCtx(opts?: { clock?; config?; path? }): Ctx & { clock: FakeClock }`.
  - `tempDbPath(): string`.

- [ ] **Step 1: Write the schema** (`server/migrations/001_init.sql`)

```sql
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  trigger_token_hash TEXT NOT NULL UNIQUE,
  trigger_token_enc TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'macos')),
  model TEXT NOT NULL,
  apns_token TEXT NOT NULL UNIQUE,
  apns_env TEXT NOT NULL CHECK (apns_env IN ('sandbox', 'production')),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX devices_account ON devices(account_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('web', 'app')),
  device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX sessions_account ON sessions(account_id);

CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  title TEXT,
  message TEXT NOT NULL,
  details TEXT,
  url TEXT,
  group_key TEXT,
  source TEXT NOT NULL CHECK (source IN ('trigger', 'test')),
  idempotency_key TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX pages_account_created ON pages(account_id, created_at DESC, id DESC);
CREATE INDEX pages_account_idempotency ON pages(account_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE delivery_jobs (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'submitted', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  apns_id TEXT,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX delivery_jobs_due ON delivery_jobs(status, next_attempt_at);
CREATE INDEX delivery_jobs_page ON delivery_jobs(page_id);
```

- [ ] **Step 2: Write the failing tests** (`server/test/db/database.test.ts`)

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase } from "../../src/db/database";
import { tempDbPath } from "../helpers";

function tempMigrations(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pagerio-mig-"));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

describe("openDatabase", () => {
  test("creates every table and turns on foreign keys", () => {
    const db = openDatabase(":memory:");
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
    expect(tables).toEqual(["accounts", "delivery_jobs", "devices", "pages", "schema_migrations", "sessions"]);
    expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
  });

  test("uses WAL on a file database and survives reopening without re-running migrations", () => {
    const path = tempDbPath();
    const first = openDatabase(path);
    expect(first.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    first.close();
    const second = openDatabase(path);
    expect(second.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM schema_migrations").get()?.n).toBe(1);
  });

  test("rejects rows that point at a missing account", () => {
    const db = openDatabase(":memory:");
    expect(() =>
      db.run("INSERT INTO devices (id, account_id, platform, model, apns_token, apns_env, created_at, last_seen_at) VALUES ('d', 'nope', 'ios', 'x', 'ab', 'sandbox', 0, 0)"),
    ).toThrow();
  });

  test("rejects values outside the allowed enums", () => {
    const db = openDatabase(":memory:");
    db.run("INSERT INTO accounts VALUES ('a', 'sub', 'e', 'h', 'enc', 0)");
    expect(() =>
      db.run("INSERT INTO devices (id, account_id, platform, model, apns_token, apns_env, created_at, last_seen_at) VALUES ('d', 'a', 'android', 'x', 'ab', 'sandbox', 0, 0)"),
    ).toThrow();
  });
});

describe("migrate", () => {
  test("is idempotent", () => {
    const db = openDatabase(":memory:");
    expect(migrate(db, join(import.meta.dir, "../../migrations"))).toEqual([]);
  });

  test("rolls back a failing migration and does not record it", () => {
    const dir = tempMigrations({
      "001_ok.sql": "CREATE TABLE ok (id TEXT);",
      "002_bad.sql": "CREATE TABLE half (id TEXT); THIS IS NOT SQL;",
    });
    const db = openDatabase(":memory:", tempMigrations({}));
    expect(() => migrate(db, dir)).toThrow();
    const versions = db.query<{ version: number }, []>("SELECT version FROM schema_migrations").all().map((r) => r.version);
    expect(versions).toEqual([1]);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'half'").get()).toBeNull();
  });

  test("refuses duplicate version numbers", () => {
    const dir = tempMigrations({ "001_a.sql": "SELECT 1;", "001_b.sql": "SELECT 1;" });
    const db = openDatabase(":memory:", tempMigrations({}));
    expect(() => migrate(db, dir)).toThrow("Duplicate migration version 1");
  });

  test("ignores files that are not numbered .sql migrations", () => {
    const dir = tempMigrations({ "README.md": "hi", "notes.sql": "garbage", "001_a.sql": "CREATE TABLE a (id TEXT);" });
    const db = openDatabase(":memory:", tempMigrations({}));
    expect(migrate(db, dir)).toEqual([1]);
  });
});
```

- [ ] **Step 3: Write `server/src/context.ts` and `server/test/helpers.ts`**

```ts
// server/src/context.ts
import type { Database } from "bun:sqlite";
import type { Config } from "./config";

export interface Ctx {
  db: Database;
  config: Config;
  now: () => number;
}
```

```ts
// server/test/helpers.ts
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
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd server && bun test test/db/database.test.ts`
Expected: FAIL with "Cannot find module '../../src/db/database'".

- [ ] **Step 5: Implement `server/src/db/database.ts`**

```ts
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");
const MIGRATION_FILE = /^(\d+)_.+\.sql$/;

export function openDatabase(path: string, migrationsDir: string = MIGRATIONS_DIR): Database {
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  migrate(db, migrationsDir);
  return db;
}

export function migrate(db: Database, dir: string): number[] {
  db.run("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const applied = new Set(
    db.query<{ version: number }, []>("SELECT version FROM schema_migrations").all().map((r) => r.version),
  );

  const migrations = readdirSync(dir)
    .map((file) => ({ file, match: MIGRATION_FILE.exec(file) }))
    .filter((m): m is { file: string; match: RegExpExecArray } => m.match !== null)
    .map(({ file, match }) => ({ file, version: Number(match[1]) }))
    .sort((a, b) => a.version - b.version);

  const seen = new Set<number>();
  for (const { version } of migrations) {
    if (seen.has(version)) throw new Error(`Duplicate migration version ${version}`);
    seen.add(version);
  }

  const ran: number[] = [];
  for (const { file, version } of migrations) {
    if (applied.has(version)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    db.transaction(() => {
      db.run(sql);
      db.query("INSERT INTO schema_migrations (version, applied_at) VALUES ($version, $at)").run({ version, at: Date.now() });
    })();
    ran.push(version);
  }
  return ran;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd server && bun test test/db/database.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server
git commit -m "feat(server): SQLite schema, migration runner and test helpers"
```

---

### Task 6: Tokens and encryption

**Files:**
- Create: `server/src/auth/tokens.ts`
- Test: `server/test/auth/tokens.test.ts`

**Interfaces:**
- Produces:
  - `randomToken(): string` (43 base64url characters).
  - `isTokenShaped(value: string): boolean`.
  - `hashToken(token: string): string` (64 hex characters).
  - `newId(prefix: string): string`.
  - `encryptSecret(key: Buffer, plaintext: string): string`.
  - `decryptSecret(key: Buffer, blob: string): string`, which throws on tampering.
  - `constantTimeEqual(a: string, b: string): boolean`.

- [ ] **Step 1: Write the failing tests** (`server/test/auth/tokens.test.ts`)

```ts
import { describe, expect, test } from "bun:test";
import { constantTimeEqual, decryptSecret, encryptSecret, hashToken, isTokenShaped, newId, randomToken } from "../../src/auth/tokens";

const key = Buffer.alloc(32, 3);

describe("randomToken", () => {
  test("is 43 url-safe characters and never repeats in 2,000 draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const t = randomToken();
      expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(isTokenShaped(t)).toBe(true);
      seen.add(t);
    }
    expect(seen.size).toBe(2000);
  });

  test("isTokenShaped rejects anything else", () => {
    for (const bad of ["", "short", "a".repeat(42), "a".repeat(44), "a".repeat(42) + "/", "a".repeat(42) + "=", "../../" + "a".repeat(37)]) {
      expect(isTokenShaped(bad)).toBe(false);
    }
  });
});

describe("hashToken", () => {
  test("is deterministic 64-char hex and differs per input", () => {
    expect(hashToken("abc")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken("abc")).toBe(hashToken("abc"));
    expect(hashToken("abc")).not.toBe(hashToken("abd"));
  });
});

describe("newId", () => {
  test("is prefixed and unique", () => {
    const a = newId("pg");
    expect(a).toMatch(/^pg_[A-Za-z0-9_-]{16}$/);
    expect(newId("pg")).not.toBe(a);
  });
});

describe("encryptSecret / decryptSecret", () => {
  test("round-trips, including non-ASCII", () => {
    for (const text of ["hello", "", "héllo 🔥"]) expect(decryptSecret(key, encryptSecret(key, text))).toBe(text);
  });

  test("uses a fresh IV each time", () => {
    expect(encryptSecret(key, "same")).not.toBe(encryptSecret(key, "same"));
  });

  test("detects any flipped byte", () => {
    const blob = Buffer.from(encryptSecret(key, "secret value"), "base64url");
    for (const index of [0, 12, blob.length - 1]) {
      const tampered = Buffer.from(blob);
      tampered[index] = tampered[index]! ^ 0x01;
      expect(() => decryptSecret(key, tampered.toString("base64url"))).toThrow();
    }
  });

  test("fails with the wrong key, a truncated blob or garbage", () => {
    const blob = encryptSecret(key, "secret");
    expect(() => decryptSecret(Buffer.alloc(32, 4), blob)).toThrow();
    expect(() => decryptSecret(key, blob.slice(0, 20))).toThrow();
    expect(() => decryptSecret(key, "")).toThrow();
    expect(() => decryptSecret(key, "%%%not-base64%%%")).toThrow();
  });
});

describe("constantTimeEqual", () => {
  test("compares by value and handles different lengths", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && bun test test/auth/tokens.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement `server/src/auth/tokens.ts`**

```ts
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function isTokenShaped(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

/** AES-256-GCM. Output: base64url(iv ‖ ciphertext ‖ tag). */
export function encryptSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString("base64url");
}

export function decryptSecret(key: Buffer, blob: string): string {
  const raw = Buffer.from(blob, "base64url");
  if (raw.length < IV_BYTES + TAG_BYTES) throw new Error("Encrypted value is too short");
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && bun test test/auth/tokens.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server
git commit -m "feat(server): token generation, hashing and AES-GCM secret encryption"
```

---

### Task 7: Accounts and sessions

**Files:**
- Create: `server/src/db/accounts.ts`, `server/src/db/sessions.ts`, `server/src/services/accounts.ts`, `server/src/services/sessions.ts`
- Modify: `server/test/helpers.ts` (add `seedAccount`)
- Test: `server/test/services/accounts.test.ts`, `server/test/services/sessions.test.ts`

**Interfaces:**
- Consumes: `Ctx`, and from `auth/tokens`: `randomToken`, `hashToken`, `newId`, `encryptSecret`, `decryptSecret`, `isTokenShaped`.
- Produces:
  - **Account types and functions:**
    - `type AccountRow = { id; google_sub; email; trigger_token_hash; trigger_token_enc; created_at }`.
    - `interface Identity { sub: string; email: string }`.
    - `findOrCreateAccount(ctx, identity): AccountRow`.
    - `findAccountByTriggerToken(ctx, token): AccountRow | null`.
    - `triggerUrl(ctx, accountId): string`.
  - **Session types and functions:**
    - `type SessionKind = "web" | "app"`.
    - `type SessionRow = { id; account_id; kind; device_id: string | null; token_hash; created_at; last_used_at }`.
    - `SESSION_IDLE_TTL_MS`.
    - `createSession(ctx, accountId, kind): { token: string; session: SessionRow }`.
    - `resolveSession(ctx, token, kind): SessionRow | null`.
    - `revokeSession(ctx, session): void`.
  - **DB functions:**
    - `db/accounts.ts`: `insertAccount`, `getAccountById`, `getAccountByGoogleSub`, `getAccountByTriggerHash`, `updateAccountEmail`.
    - `db/sessions.ts`: `insertSession`, `getSessionByHash`, `touchSession`, `deleteSession`, `setSessionDevice`.
  - **Test helper:** `seedAccount(ctx, sub?, email?): { account: AccountRow; triggerToken: string }`.

- [ ] **Step 1: Write the failing account tests** (`server/test/services/accounts.test.ts`)

```ts
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
  test("has the base URL and a 43-char token, and resolves back to the account", () => {
    const ctx = testCtx();
    const account = findOrCreateAccount(ctx, { sub: "s1", email: "a@example.com" });
    const url = triggerUrl(ctx, account.id);
    expect(url).toMatch(/^https:\/\/pager\.test\/p\/[A-Za-z0-9_-]{43}$/);
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
    for (const bad of [flipped, token.slice(0, 42), token + "x", "", "../../etc/passwd", "' OR 1=1 --", "x".repeat(10_000)]) {
      expect(findAccountByTriggerToken(ctx, bad)).toBeNull();
    }
  });

  test("triggerUrl throws for an unknown account", () => {
    expect(() => triggerUrl(testCtx(), "acct_missing")).toThrow();
  });
});
```

- [ ] **Step 2: Write the failing session tests** (`server/test/services/sessions.test.ts`)

```ts
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd server && bun test test/services`
Expected: FAIL with "Cannot find module".

- [ ] **Step 4: Implement the DB modules**

`server/src/db/accounts.ts`:

```ts
import type { Database } from "bun:sqlite";

export type AccountRow = {
  id: string;
  google_sub: string;
  email: string;
  trigger_token_hash: string;
  trigger_token_enc: string;
  created_at: number;
};

export function insertAccount(db: Database, row: AccountRow): void {
  db.query(
    `INSERT INTO accounts (id, google_sub, email, trigger_token_hash, trigger_token_enc, created_at)
     VALUES ($id, $google_sub, $email, $trigger_token_hash, $trigger_token_enc, $created_at)`,
  ).run(row);
}

export function getAccountById(db: Database, id: string): AccountRow | null {
  return db.query<AccountRow, { id: string }>("SELECT * FROM accounts WHERE id = $id").get({ id }) ?? null;
}

export function getAccountByGoogleSub(db: Database, sub: string): AccountRow | null {
  return db.query<AccountRow, { sub: string }>("SELECT * FROM accounts WHERE google_sub = $sub").get({ sub }) ?? null;
}

export function getAccountByTriggerHash(db: Database, hash: string): AccountRow | null {
  return db.query<AccountRow, { hash: string }>("SELECT * FROM accounts WHERE trigger_token_hash = $hash").get({ hash }) ?? null;
}

export function updateAccountEmail(db: Database, id: string, email: string): void {
  db.query("UPDATE accounts SET email = $email WHERE id = $id").run({ id, email });
}
```

`server/src/db/sessions.ts`:

```ts
import type { Database } from "bun:sqlite";

export type SessionKind = "web" | "app";

export type SessionRow = {
  id: string;
  account_id: string;
  kind: SessionKind;
  device_id: string | null;
  token_hash: string;
  created_at: number;
  last_used_at: number;
};

export function insertSession(db: Database, row: SessionRow): void {
  db.query(
    `INSERT INTO sessions (id, account_id, kind, device_id, token_hash, created_at, last_used_at)
     VALUES ($id, $account_id, $kind, $device_id, $token_hash, $created_at, $last_used_at)`,
  ).run(row);
}

export function getSessionByHash(db: Database, hash: string): SessionRow | null {
  return db.query<SessionRow, { hash: string }>("SELECT * FROM sessions WHERE token_hash = $hash").get({ hash }) ?? null;
}

export function touchSession(db: Database, id: string, at: number): void {
  db.query("UPDATE sessions SET last_used_at = $at WHERE id = $id").run({ id, at });
}

export function deleteSession(db: Database, id: string): void {
  db.query("DELETE FROM sessions WHERE id = $id").run({ id });
}

export function setSessionDevice(db: Database, id: string, deviceId: string): void {
  db.query("UPDATE sessions SET device_id = $deviceId WHERE id = $id").run({ id, deviceId });
}
```

- [ ] **Step 5: Implement the services**

`server/src/services/accounts.ts`:

```ts
import { decryptSecret, encryptSecret, hashToken, isTokenShaped, newId, randomToken } from "../auth/tokens";
import type { Ctx } from "../context";
import {
  type AccountRow,
  getAccountByGoogleSub,
  getAccountById,
  getAccountByTriggerHash,
  insertAccount,
  updateAccountEmail,
} from "../db/accounts";

export type { AccountRow };

export interface Identity {
  sub: string;
  email: string;
}

export function findOrCreateAccount(ctx: Ctx, identity: Identity): AccountRow {
  return ctx.db.transaction(() => {
    const existing = getAccountByGoogleSub(ctx.db, identity.sub);
    if (existing) {
      if (existing.email !== identity.email) updateAccountEmail(ctx.db, existing.id, identity.email);
      return { ...existing, email: identity.email };
    }
    const token = randomToken();
    const row: AccountRow = {
      id: newId("acct"),
      google_sub: identity.sub,
      email: identity.email,
      trigger_token_hash: hashToken(token),
      trigger_token_enc: encryptSecret(ctx.config.tokenEncKey, token),
      created_at: ctx.now(),
    };
    insertAccount(ctx.db, row);
    return row;
  })();
}

export function findAccountByTriggerToken(ctx: Ctx, token: string): AccountRow | null {
  if (!isTokenShaped(token)) return null;
  return getAccountByTriggerHash(ctx.db, hashToken(token));
}

export function triggerUrl(ctx: Ctx, accountId: string): string {
  const account = getAccountById(ctx.db, accountId);
  if (!account) throw new Error("Account not found");
  return `${ctx.config.publicBaseUrl}/p/${decryptSecret(ctx.config.tokenEncKey, account.trigger_token_enc)}`;
}
```

`server/src/services/sessions.ts`:

```ts
import { hashToken, isTokenShaped, newId, randomToken } from "../auth/tokens";
import type { Ctx } from "../context";
import { deleteSession, getSessionByHash, insertSession, type SessionKind, type SessionRow, touchSession } from "../db/sessions";

export type { SessionKind, SessionRow };

export const SESSION_IDLE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export function createSession(ctx: Ctx, accountId: string, kind: SessionKind): { token: string; session: SessionRow } {
  const token = randomToken();
  const now = ctx.now();
  const session: SessionRow = {
    id: newId("ses"),
    account_id: accountId,
    kind,
    device_id: null,
    token_hash: hashToken(token),
    created_at: now,
    last_used_at: now,
  };
  insertSession(ctx.db, session);
  return { token, session };
}

export function resolveSession(ctx: Ctx, token: string, kind: SessionKind): SessionRow | null {
  if (!isTokenShaped(token)) return null;
  const session = getSessionByHash(ctx.db, hashToken(token));
  if (!session || session.kind !== kind) return null;
  const now = ctx.now();
  if (now - session.last_used_at > SESSION_IDLE_TTL_MS) {
    deleteSession(ctx.db, session.id);
    return null;
  }
  touchSession(ctx.db, session.id, now);
  return { ...session, last_used_at: now };
}

export function revokeSession(ctx: Ctx, session: SessionRow): void {
  deleteSession(ctx.db, session.id);
}
```

- [ ] **Step 6: Add `seedAccount` to `server/test/helpers.ts`**

Add this import at the top:

```ts
import { type AccountRow, findOrCreateAccount, triggerUrl } from "../src/services/accounts";
```

Append:

```ts
export function seedAccount(ctx: Ctx, sub = "sub-1", email = "a@example.com"): { account: AccountRow; triggerToken: string } {
  const account = findOrCreateAccount(ctx, { sub, email });
  const triggerToken = triggerUrl(ctx, account.id).split("/p/")[1]!;
  return { account, triggerToken };
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd server && bun test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server
git commit -m "feat(server): accounts with encrypted trigger URL and hashed sessions with idle expiry"
```

---

### Task 8: Google ID-token verification and web OAuth client

**Files:**
- Create: `server/src/auth/google.ts`, `server/src/auth/googleOAuth.ts`
- Test: `server/test/auth/google.test.ts`

**Interfaces:**
- Consumes: `Identity` from `services/accounts`.
- Produces:
  - `class AuthError`.
  - `interface GoogleVerifier { verify(idToken: string): Promise<Identity> }`.
  - `createGoogleVerifier(audiences: string[], keys?: JWTVerifyGetKey): GoogleVerifier`.
  - `interface GoogleOAuthClient { authorizationUrl(state: string): string; exchangeCode(code: string): Promise<string> }`, where `exchangeCode` resolves to the ID token.
  - `createGoogleOAuthClient(opts: { clientId; clientSecret; redirectUri; fetchFn?: typeof fetch }): GoogleOAuthClient`.

- [ ] **Step 1: Write the failing tests** (`server/test/auth/google.test.ts`)

```ts
import { beforeAll, describe, expect, test } from "bun:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { AuthError, createGoogleVerifier } from "../../src/auth/google";
import { createGoogleOAuthClient } from "../../src/auth/googleOAuth";

let signingKey: CryptoKey;
let otherKey: CryptoKey;
let verifier: ReturnType<typeof createGoogleVerifier>;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey;
  otherKey = (await generateKeyPair("RS256")).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" };
  verifier = createGoogleVerifier(["web-client", "ios-client"], createLocalJWKSet({ keys: [jwk] }));
});

async function idToken(claims: JWTPayload = {}, opts: { key?: CryptoKey; exp?: string | number } = {}): Promise<string> {
  return new SignJWT({ email: "a@example.com", email_verified: true, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer((claims.iss as string) ?? "https://accounts.google.com")
    .setAudience((claims.aud as string) ?? "ios-client")
    .setSubject((claims.sub as string) ?? "google-123")
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "10m")
    .sign(opts.key ?? signingKey);
}

describe("createGoogleVerifier", () => {
  test("accepts a valid token for any configured audience and either issuer form", async () => {
    expect(await verifier.verify(await idToken())).toEqual({ sub: "google-123", email: "a@example.com" });
    expect((await verifier.verify(await idToken({ aud: "web-client", iss: "accounts.google.com" }))).sub).toBe("google-123");
  });

  const rejects: Array<[string, () => Promise<string>]> = [
    ["a foreign audience", () => idToken({ aud: "someone-elses-client" })],
    ["a foreign issuer", () => idToken({ iss: "https://evil.example" })],
    ["an expired token", () => idToken({}, { exp: Math.floor(Date.now() / 1000) - 120 })],
    ["a token signed by another key", () => idToken({}, { key: otherKey })],
    ["an unverified email", () => idToken({ email_verified: false })],
    ["a missing email", () => idToken({ email: undefined })],
    ["an empty subject", () => idToken({ sub: "" })],
    ["an alg=none token", async () => `${btoa('{"alg":"none"}')}.${btoa('{"sub":"x","aud":"ios-client"}')}.`],
    ["garbage", async () => "not.a.jwt"],
    ["an empty string", async () => ""],
  ];
  for (const [name, make] of rejects) {
    test(`rejects ${name}`, async () => {
      await expect(verifier.verify(await make())).rejects.toBeInstanceOf(AuthError);
    });
  }
});

describe("createGoogleOAuthClient", () => {
  const base = { clientId: "web-client", clientSecret: "shh", redirectUri: "https://pager.test/auth/google/callback" };

  test("builds an authorization URL carrying the state", () => {
    const url = new URL(createGoogleOAuthClient(base).authorizationUrl("st&ate=1"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("state")).toBe("st&ate=1");
    expect(url.searchParams.get("client_id")).toBe("web-client");
    expect(url.searchParams.get("redirect_uri")).toBe(base.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid email");
  });

  test("exchanges a code and returns the id_token", async () => {
    let sent: URLSearchParams | null = null;
    const client = createGoogleOAuthClient({
      ...base,
      fetchFn: (async (_url: string, init: RequestInit) => {
        sent = new URLSearchParams(init.body as string);
        return new Response(JSON.stringify({ id_token: "the-id-token" }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(await client.exchangeCode("code-1")).toBe("the-id-token");
    expect(sent!.get("code")).toBe("code-1");
    expect(sent!.get("grant_type")).toBe("authorization_code");
    expect(sent!.get("client_secret")).toBe("shh");
  });

  for (const [name, response] of [
    ["an error status", new Response('{"error":"invalid_grant"}', { status: 400 })],
    ["a missing id_token", new Response("{}", { status: 200 })],
    ["a non-JSON body", new Response("<html>", { status: 200 })],
  ] as const) {
    test(`throws AuthError on ${name}`, async () => {
      const client = createGoogleOAuthClient({ ...base, fetchFn: (async () => response) as unknown as typeof fetch });
      await expect(client.exchangeCode("c")).rejects.toBeInstanceOf(AuthError);
    });
  }

  test("throws AuthError when the network fails", async () => {
    const client = createGoogleOAuthClient({
      ...base,
      fetchFn: (async () => {
        throw new TypeError("network down");
      }) as unknown as typeof fetch,
    });
    await expect(client.exchangeCode("c")).rejects.toBeInstanceOf(AuthError);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && bun test test/auth/google.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement `server/src/auth/google.ts`**

```ts
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { Identity } from "../services/accounts";

export class AuthError extends Error {}

export interface GoogleVerifier {
  verify(idToken: string): Promise<Identity>;
}

const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const GOOGLE_JWKS_URL = new URL("https://www.googleapis.com/oauth2/v3/certs");

export function createGoogleVerifier(
  audiences: string[],
  keys: JWTVerifyGetKey = createRemoteJWKSet(GOOGLE_JWKS_URL),
): GoogleVerifier {
  return {
    async verify(idToken) {
      let payload: Record<string, unknown>;
      try {
        ({ payload } = await jwtVerify(idToken, keys, {
          issuer: GOOGLE_ISSUERS,
          audience: audiences,
          algorithms: ["RS256"],
          clockTolerance: 30,
        }));
      } catch {
        throw new AuthError("invalid_id_token");
      }
      if (typeof payload.sub !== "string" || payload.sub === "") throw new AuthError("missing_subject");
      if (typeof payload.email !== "string" || payload.email_verified !== true) throw new AuthError("unverified_email");
      return { sub: payload.sub, email: payload.email };
    },
  };
}
```

- [ ] **Step 4: Implement `server/src/auth/googleOAuth.ts`**

```ts
import { AuthError } from "./google";

export interface GoogleOAuthClient {
  authorizationUrl(state: string): string;
  exchangeCode(code: string): Promise<string>;
}

export function createGoogleOAuthClient(opts: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchFn?: typeof fetch;
}): GoogleOAuthClient {
  const fetchFn = opts.fetchFn ?? fetch;
  return {
    authorizationUrl(state) {
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.search = new URLSearchParams({
        client_id: opts.clientId,
        redirect_uri: opts.redirectUri,
        response_type: "code",
        scope: "openid email",
        state,
        prompt: "select_account",
      }).toString();
      return url.toString();
    },
    async exchangeCode(code) {
      let body: { id_token?: unknown };
      try {
        const res = await fetchFn("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: opts.clientId,
            client_secret: opts.clientSecret,
            redirect_uri: opts.redirectUri,
            grant_type: "authorization_code",
          }).toString(),
        });
        if (!res.ok) throw new AuthError("code_exchange_failed");
        body = (await res.json()) as { id_token?: unknown };
      } catch {
        throw new AuthError("code_exchange_failed");
      }
      if (typeof body.id_token !== "string" || body.id_token === "") throw new AuthError("missing_id_token");
      return body.id_token;
    },
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && bun test test/auth/google.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server
git commit -m "feat(server): Google ID-token verification and web OAuth code exchange"
```

---

### Task 9: Device registration

**Files:**
- Create: `server/src/db/devices.ts`, `server/src/services/devices.ts`
- Modify: `server/src/services/sessions.ts` (`revokeSession` deletes the session's device), `server/test/helpers.ts` (add `seedDevice`)
- Test: `server/test/services/devices.test.ts`

**Interfaces:**
- Consumes: `SessionRow`, `setSessionDevice`, `ApnsEnv`, `Platform`.
- Produces:
  - `type DeviceRow = { id; account_id; platform: Platform; model; apns_token; apns_env: ApnsEnv; created_at; last_seen_at }`.
  - **db/devices.ts:** `insertDevice`, `getDevice`, `getDeviceByToken`, `updateDevice`, `deleteDevice`, `listDevicesForAccount(db, accountId): DeviceRow[]`.
  - `interface DeviceInput { apnsToken: string; platform: Platform; model: string; apnsEnv: ApnsEnv }`.
  - `parseDeviceInput(body: unknown): { ok: true; value: DeviceInput } | { ok: false; message: string }`.
  - `registerCurrentDevice(ctx, session, input): DeviceRow`.
  - **Test helper:** `seedDevice(ctx, accountId, overrides?: Partial<DeviceInput>): { device: DeviceRow; sessionToken: string; session: SessionRow }`.

- [ ] **Step 1: Write the failing tests** (`server/test/services/devices.test.ts`)

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && bun test test/services/devices.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement `server/src/db/devices.ts`**

```ts
import type { Database } from "bun:sqlite";
import type { ApnsEnv, Platform } from "../config";

export type DeviceRow = {
  id: string;
  account_id: string;
  platform: Platform;
  model: string;
  apns_token: string;
  apns_env: ApnsEnv;
  created_at: number;
  last_seen_at: number;
};

export function insertDevice(db: Database, row: DeviceRow): void {
  db.query(
    `INSERT INTO devices (id, account_id, platform, model, apns_token, apns_env, created_at, last_seen_at)
     VALUES ($id, $account_id, $platform, $model, $apns_token, $apns_env, $created_at, $last_seen_at)`,
  ).run(row);
}

export function getDevice(db: Database, id: string): DeviceRow | null {
  return db.query<DeviceRow, { id: string }>("SELECT * FROM devices WHERE id = $id").get({ id }) ?? null;
}

export function getDeviceByToken(db: Database, token: string): DeviceRow | null {
  return db.query<DeviceRow, { token: string }>("SELECT * FROM devices WHERE apns_token = $token").get({ token }) ?? null;
}

export function updateDevice(
  db: Database,
  id: string,
  fields: Pick<DeviceRow, "platform" | "model" | "apns_token" | "apns_env" | "last_seen_at">,
): void {
  db.query(
    `UPDATE devices SET platform = $platform, model = $model, apns_token = $apns_token,
       apns_env = $apns_env, last_seen_at = $last_seen_at WHERE id = $id`,
  ).run({ id, ...fields });
}

export function deleteDevice(db: Database, id: string): void {
  db.query("DELETE FROM devices WHERE id = $id").run({ id });
}

export function listDevicesForAccount(db: Database, accountId: string): DeviceRow[] {
  return db
    .query<DeviceRow, { accountId: string }>("SELECT * FROM devices WHERE account_id = $accountId ORDER BY created_at")
    .all({ accountId });
}
```

- [ ] **Step 4: Implement `server/src/services/devices.ts`**

```ts
import { newId } from "../auth/tokens";
import type { ApnsEnv, Platform } from "../config";
import type { Ctx } from "../context";
import { type DeviceRow, deleteDevice, getDevice, getDeviceByToken, insertDevice, updateDevice } from "../db/devices";
import { setSessionDevice, type SessionRow } from "../db/sessions";

export type { DeviceRow };

export interface DeviceInput {
  apnsToken: string;
  platform: Platform;
  model: string;
  apnsEnv: ApnsEnv;
}

const APNS_TOKEN = /^[0-9a-f]{64,200}$/;
const MAX_MODEL_LENGTH = 100;

export function parseDeviceInput(body: unknown): { ok: true; value: DeviceInput } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, message: "Body must be a JSON object." };
  const b = body as Record<string, unknown>;
  const token = typeof b.apns_token === "string" ? b.apns_token.toLowerCase() : "";
  if (!APNS_TOKEN.test(token)) return { ok: false, message: "apns_token must be 64–200 hex characters." };
  if (b.platform !== "ios" && b.platform !== "macos") return { ok: false, message: "platform must be ios or macos." };
  if (b.apns_env !== "sandbox" && b.apns_env !== "production") return { ok: false, message: "apns_env must be sandbox or production." };
  const model = typeof b.model === "string" ? b.model.trim().slice(0, MAX_MODEL_LENGTH) : "";
  if (!model) return { ok: false, message: "model is required." };
  return { ok: true, value: { apnsToken: token, platform: b.platform, model, apnsEnv: b.apns_env } };
}

export function registerCurrentDevice(ctx: Ctx, session: SessionRow, input: DeviceInput): DeviceRow {
  return ctx.db.transaction(() => {
    const now = ctx.now();
    const current = session.device_id ? getDevice(ctx.db, session.device_id) : null;
    const holder = getDeviceByToken(ctx.db, input.apnsToken);
    // The token now belongs to this session. Any other row holding it is stale
    // (reinstall, or the phone signed into another account); deleting it also deletes its session.
    if (holder && holder.id !== current?.id) deleteDevice(ctx.db, holder.id);

    const fields = {
      platform: input.platform,
      model: input.model,
      apns_token: input.apnsToken,
      apns_env: input.apnsEnv,
      last_seen_at: now,
    };
    if (current && current.account_id === session.account_id) {
      updateDevice(ctx.db, current.id, fields);
      return { ...current, ...fields };
    }
    const row: DeviceRow = { id: newId("dev"), account_id: session.account_id, created_at: now, ...fields };
    insertDevice(ctx.db, row);
    setSessionDevice(ctx.db, session.id, row.id);
    return row;
  })();
}
```

- [ ] **Step 5: Update `revokeSession` in `server/src/services/sessions.ts`**

Add the import:

```ts
import { deleteDevice } from "../db/devices";
```

Replace `revokeSession` with:

```ts
/** App sign-out removes the device too (its session cascades), so a signed-out phone stops getting pages. */
export function revokeSession(ctx: Ctx, session: SessionRow): void {
  ctx.db.transaction(() => {
    if (session.kind === "app" && session.device_id) deleteDevice(ctx.db, session.device_id);
    deleteSession(ctx.db, session.id);
  })();
}
```

- [ ] **Step 6: Add `seedDevice` to `server/test/helpers.ts`**

Add these imports:

```ts
import { type DeviceInput, type DeviceRow, registerCurrentDevice } from "../src/services/devices";
import { createSession, type SessionRow } from "../src/services/sessions";
```

Append:

```ts
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
```

- [ ] **Step 7: Run all tests**

Run: `cd server && bun test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server
git commit -m "feat(server): device registration with token hand-over and sign-out removal"
```

---

### Task 10: Trigger body parsing

**Files:**
- Create: `server/src/services/pageInput.ts`
- Test: `server/test/services/pageInput.test.ts`

**Interfaces:**
- Produces:
  - `const DEFAULT_MESSAGE = "You've been paged."`.
  - `const LIMITS = { title: 100, message: 1000, details: 10000, url: 2048, group: 50, bodyBytes: 16384, idempotencyKey: 200 }`.
  - `interface PageInput { title: string | null; message: string; details: string | null; url: string | null; group: string | null }`.
  - `parseTriggerBody(contentType: string | undefined, body: Uint8Array): { ok: true; value: PageInput } | { ok: false; message: string }`.

- [ ] **Step 1: Write the failing tests** (`server/test/services/pageInput.test.ts`)

```ts
import { describe, expect, test } from "bun:test";
import { DEFAULT_MESSAGE, parseTriggerBody } from "../../src/services/pageInput";

const enc = (s: string) => new TextEncoder().encode(s);
const json = (v: unknown) => parseTriggerBody("application/json", enc(JSON.stringify(v)));
const empty = { title: null, details: null, url: null, group: null };

describe("plain bodies", () => {
  test("an empty or whitespace body uses the default message", () => {
    expect(parseTriggerBody(undefined, new Uint8Array())).toEqual({ ok: true, value: { ...empty, message: DEFAULT_MESSAGE } });
    expect(parseTriggerBody("text/plain", enc("  \n\t "))).toEqual({ ok: true, value: { ...empty, message: DEFAULT_MESSAGE } });
  });

  test("curl -d (form content type) is treated as plain text", () => {
    const parsed = parseTriggerBody("application/x-www-form-urlencoded", enc("Your deployment is ready\n"));
    expect(parsed).toEqual({ ok: true, value: { ...empty, message: "Your deployment is ready" } });
  });

  test("JSON-looking text without a JSON content type stays plain text", () => {
    const parsed = parseTriggerBody("text/plain", enc('{"title":"x"}'));
    expect(parsed.ok && parsed.value.message).toBe('{"title":"x"}');
  });

  test("plain text longer than 1,000 characters is rejected", () => {
    expect(parseTriggerBody("text/plain", enc("a".repeat(1001))).ok).toBe(false);
    expect(parseTriggerBody("text/plain", enc("a".repeat(1000))).ok).toBe(true);
  });

  test("invalid UTF-8 is rejected", () => {
    expect(parseTriggerBody("text/plain", new Uint8Array([0xff, 0xfe, 0x41]))).toEqual({ ok: false, message: "Body must be UTF-8 text." });
  });
});

describe("JSON bodies", () => {
  test("reads every field and trims text", () => {
    expect(json({ title: " Build ", message: " Done ", details: "**ok**", url: "https://e.com/1", group: "ci" })).toEqual({
      ok: true,
      value: { title: "Build", message: "Done", details: "**ok**", url: "https://e.com/1", group: "ci" },
    });
  });

  test("content type matching ignores case and parameters", () => {
    expect(parseTriggerBody("Application/JSON; charset=utf-8", enc('{"message":"hi"}'))).toEqual({ ok: true, value: { ...empty, message: "hi" } });
  });

  test("{} and null fields fall back to defaults; unknown fields are ignored", () => {
    expect(json({})).toEqual({ ok: true, value: { ...empty, message: DEFAULT_MESSAGE } });
    expect(json({ title: null, message: null, extra: { deep: true } })).toEqual({ ok: true, value: { ...empty, message: DEFAULT_MESSAGE } });
  });

  test("limits are counted in characters, not bytes", () => {
    expect(json({ title: "🚨".repeat(100) }).ok).toBe(true);
    expect(json({ title: "🚨".repeat(101) }).ok).toBe(false);
  });

  const rejected: Array<[string, unknown]> = [
    ["a long title", { title: "t".repeat(101) }],
    ["a long message", { message: "m".repeat(1001) }],
    ["long details", { details: "d".repeat(10_001) }],
    ["a long group", { group: "g".repeat(51) }],
    ["a numeric title", { title: 123 }],
    ["a boolean message", { message: true }],
    ["an object url", { url: { href: "https://e.com" } }],
    ["a javascript: url", { url: "javascript:alert(1)" }],
    ["a file: url", { url: "file:///etc/passwd" }],
    ["a data: url", { url: "data:text/html,<script>alert(1)</script>" }],
    ["an ftp url", { url: "ftp://e.com" }],
    ["a relative url", { url: "/just/a/path" }],
    ["a url over 2,048 characters", { url: "https://e.com/" + "a".repeat(2048) }],
  ];
  for (const [name, body] of rejected) {
    test(`rejects ${name}`, () => expect(json(body).ok).toBe(false));
  }

  test("rejects invalid JSON without echoing the body back", () => {
    const parsed = parseTriggerBody("application/json", enc("{TOP-SECRET"));
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.message).not.toContain("TOP-SECRET");
  });

  test("rejects JSON that is not an object", () => {
    for (const raw of ["[]", "null", '"text"', "42"]) expect(parseTriggerBody("application/json", enc(raw)).ok).toBe(false);
  });

  test("an empty body with a JSON content type is the default page", () => {
    expect(parseTriggerBody("application/json", new Uint8Array())).toEqual({ ok: true, value: { ...empty, message: DEFAULT_MESSAGE } });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && bun test test/services/pageInput.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement `server/src/services/pageInput.ts`**

```ts
export const DEFAULT_MESSAGE = "You've been paged.";

export const LIMITS = {
  title: 100,
  message: 1000,
  details: 10_000,
  url: 2048,
  group: 50,
  bodyBytes: 16_384,
  idempotencyKey: 200,
} as const;

export interface PageInput {
  title: string | null;
  message: string;
  details: string | null;
  url: string | null;
  group: string | null;
}

type ParseResult = { ok: true; value: PageInput } | { ok: false; message: string };
type Field = { ok: true; value: string | null } | { ok: false; message: string };

const decoder = new TextDecoder("utf-8", { fatal: true });
const codePoints = (s: string) => [...s].length;

function textField(source: Record<string, unknown>, name: keyof typeof LIMITS, trim: boolean): Field {
  const raw = source[name];
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, message: `${name} must be a string.` };
  const value = trim ? raw.trim() : raw;
  if (codePoints(value) > LIMITS[name]) return { ok: false, message: `${name} must be at most ${LIMITS[name]} characters.` };
  return { ok: true, value: value === "" ? null : value };
}

function urlField(source: Record<string, unknown>): Field {
  const field = textField(source, "url", true);
  if (!field.ok || field.value === null) return field;
  let parsed: URL;
  try {
    parsed = new URL(field.value);
  } catch {
    return { ok: false, message: "url must be an absolute http(s) URL." };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { ok: false, message: "url must be an absolute http(s) URL." };
  return { ok: true, value: field.value };
}

export function parseTriggerBody(contentType: string | undefined, body: Uint8Array): ParseResult {
  let text: string;
  try {
    text = decoder.decode(body);
  } catch {
    return { ok: false, message: "Body must be UTF-8 text." };
  }

  const isJson = (contentType ?? "").split(";")[0]!.trim().toLowerCase() === "application/json";
  if (!isJson) {
    const message = text.trim();
    if (codePoints(message) > LIMITS.message) return { ok: false, message: `message must be at most ${LIMITS.message} characters.` };
    return { ok: true, value: { title: null, message: message || DEFAULT_MESSAGE, details: null, url: null, group: null } };
  }

  if (text.trim() === "") return { ok: true, value: { title: null, message: DEFAULT_MESSAGE, details: null, url: null, group: null } };

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, message: "Body is not valid JSON." };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { ok: false, message: "JSON body must be an object." };
  const source = data as Record<string, unknown>;

  const title = textField(source, "title", true);
  if (!title.ok) return title;
  const message = textField(source, "message", true);
  if (!message.ok) return message;
  const details = textField(source, "details", false);
  if (!details.ok) return details;
  const group = textField(source, "group", true);
  if (!group.ok) return group;
  const url = urlField(source);
  if (!url.ok) return url;

  return {
    ok: true,
    value: {
      title: title.value,
      message: message.value ?? DEFAULT_MESSAGE,
      details: details.value,
      url: url.value,
      group: group.value,
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && bun test test/services/pageInput.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server
git commit -m "feat(server): strict trigger body parsing for text and JSON"
```

---

### Task 11: Creating pages (idempotency, rate limits, delivery jobs)

**Files:**
- Create: `server/src/db/pages.ts`, `server/src/db/jobs.ts`, `server/src/services/pages.ts`
- Test: `server/test/services/pages.test.ts`

**Interfaces:**
- Consumes: `PageInput`, `listDevicesForAccount`, `newId`, `randomToken`, `Ctx`.
- Produces:
  - **Types:**
    - `type PageSource = "trigger" | "test"`.
    - `type PageRow = { id; public_id; account_id; title; message; details; url; group_key; source; idempotency_key; created_at }`.
    - `type JobStatus = "pending" | "sending" | "submitted" | "failed"`.
    - `type JobRow = { id; page_id; device_id: string | null; status: JobStatus; attempts; next_attempt_at; apns_id; last_error; updated_at }`.
  - **db/pages.ts:** `insertPage`, `getPageById`, `getPageByPublicId`, `findRecentPageByIdempotencyKey`, `countPagesSince`, `oldestPageSince`, `listPages`.
  - **db/jobs.ts:** `insertJob`.
  - **services/pages.ts:**
    - `PAGE_RETENTION_MS` (30 days).
    - `viewUrl(config, publicId): string`.
    - `createPage(ctx, args: { accountId; input: PageInput; source: PageSource; idempotencyKey: string | null }): { ok: true; page: PageRow; created: boolean } | { ok: false; code: "rate_limited"; retryAfterSeconds: number }`.
    - `TEST_PAGE_INPUT: PageInput`.

- [ ] **Step 1: Write the failing tests** (`server/test/services/pages.test.ts`)

```ts
import { describe, expect, test } from "bun:test";
import { createPage, TEST_PAGE_INPUT, viewUrl } from "../../src/services/pages";
import { DEFAULT_MESSAGE, type PageInput } from "../../src/services/pageInput";
import { seedAccount, seedDevice, testCtx } from "../helpers";

const input = (message = "hello"): PageInput => ({ title: null, message, details: null, url: null, group: null });
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function count(ctx: ReturnType<typeof testCtx>, table: string): number {
  return ctx.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
}

describe("createPage", () => {
  test("stores the page and one pending job per device, due now", () => {
    const ctx = testCtx();
    const { account } = seedAccount(ctx);
    seedDevice(ctx, account.id);
    seedDevice(ctx, account.id, { platform: "macos" });
    const result = createPage(ctx, { accountId: account.id, input: input(), source: "trigger", idempotencyKey: null });
    expect(result.ok && result.created).toBe(true);
    const jobs = ctx.db.query<{ status: string; next_attempt_at: number }, []>("SELECT status, next_attempt_at FROM delivery_jobs").all();
    expect(jobs).toEqual([
      { status: "pending", next_attempt_at: ctx.clock.t },
      { status: "pending", next_attempt_at: ctx.clock.t },
    ]);
  });

  test("an account without devices still gets its page, with no jobs", () => {
    const ctx = testCtx();
    const { account } = seedAccount(ctx);
    expect(createPage(ctx, { accountId: account.id, input: input(), source: "trigger", idempotencyKey: null }).ok).toBe(true);
    expect(count(ctx, "pages")).toBe(1);
    expect(count(ctx, "delivery_jobs")).toBe(0);
  });

  test("does not page devices of other accounts", () => {
    const ctx = testCtx();
    const a = seedAccount(ctx, "a");
    const b = seedAccount(ctx, "b");
    seedDevice(ctx, b.account.id);
    createPage(ctx, { accountId: a.account.id, input: input(), source: "trigger", idempotencyKey: null });
    expect(count(ctx, "delivery_jobs")).toBe(0);
  });

  test("public_id is a fresh 43-character token distinct from the id", () => {
    const ctx = testCtx();
    const { account } = seedAccount(ctx);
    const r1 = createPage(ctx, { accountId: account.id, input: input(), source: "trigger", idempotencyKey: null });
    const r2 = createPage(ctx, { accountId: account.id, input: input(), source: "trigger", idempotencyKey: null });
    if (!r1.ok || !r2.ok) throw new Error("expected ok");
    expect(r1.page.public_id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r1.page.public_id).not.toBe(r2.page.public_id);
    expect(viewUrl(ctx.config, r1.page.public_id)).toBe(`https://pager.test/v/${r1.page.public_id}`);
  });

  describe("idempotency", () => {
    test("the same key within 24 hours returns the original page and creates nothing", () => {
      const ctx = testCtx();
      const { account } = seedAccount(ctx);
      seedDevice(ctx, account.id);
      const first = createPage(ctx, { accountId: account.id, input: input("one"), source: "trigger", idempotencyKey: "k1" });
      ctx.clock.advance(DAY - 1);
      const again = createPage(ctx, { accountId: account.id, input: input("two"), source: "trigger", idempotencyKey: "k1" });
      if (!first.ok || !again.ok) throw new Error("expected ok");
      expect(again.page.id).toBe(first.page.id);
      expect(again.created).toBe(false);
      expect(again.page.message).toBe("one");
      expect(count(ctx, "pages")).toBe(1);
      expect(count(ctx, "delivery_jobs")).toBe(1);
    });

    test("the same key after 24 hours creates a new page", () => {
      const ctx = testCtx();
      const { account } = seedAccount(ctx);
      createPage(ctx, { accountId: account.id, input: input(), source: "trigger", idempotencyKey: "k1" });
      ctx.clock.advance(DAY + 1);
      const later = createPage(ctx, { accountId: account.id, input: input(), source: "trigger", idempotencyKey: "k1" });
      expect(later.ok && later.created).toBe(true);
      expect(count(ctx, "pages")).toBe(2);
    });

    test("the same key on two accounts creates two pages", () => {
      const ctx = testCtx();
      const a = seedAccount(ctx, "a");
      const b = seedAccount(ctx, "b");
      createPage(ctx, { accountId: a.account.id, input: input(), source: "trigger", idempotencyKey: "shared" });
      const other = createPage(ctx, { accountId: b.account.id, input: input(), source: "trigger", idempotencyKey: "shared" });
      expect(other.ok && other.created).toBe(true);
    });

    test("a replay is answered even when the account is rate-limited", () => {
      const ctx = testCtx();
      const { account } = seedAccount(ctx);
      const original = createPage(ctx, { accountId: account.id, input: input(), source: "trigger", idempotencyKey: "k" });
      for (let i = 0; i < 9; i++) createPage(ctx, { accountId: account.id, input: input(), source: "trigger", idempotencyKey: null });
      const replay = createPage(ctx, { accountId: account.id, input: input(), source: "trigger", idempotencyKey: "k" });
      expect(replay.ok && original.ok && replay.page.id === original.page.id).toBe(true);
    });
  });

  describe("rate limits", () => {
    test("the 11th page in a minute is refused with an accurate Retry-After", () => {
      const ctx = testCtx();
      const { account } = seedAccount(ctx);
      for (let i = 0; i < 10; i++) {
        expect(createPage(ctx, { accountId: account.id, input: input(), source: "trigger", idempotencyKey: null }).ok).toBe(true);
        ctx.clock.advance(1000);
      }
      const refused = createPage(ctx, { accountId: account.id, input: input(), source: "trigger", idempotencyKey: null });
      expect(refused).toEqual({ ok: false, code: "rate_limited", retryAfterSeconds: 50 });
      expect(count(ctx, "pages")).toBe(10);
      ctx.clock.advance(50_000);
      expect(createPage(ctx, { accountId: account.id, input: input(), source: "trigger", idempotencyKey: null }).ok).toBe(true);
    });

    test("the daily cap applies even when pages are spread out", () => {
      const ctx = testCtx();
      const { account } = seedAccount(ctx);
      for (let i = 0; i < 100; i++) {
        expect(createPage(ctx, { accountId: account.id, input: input(), source: "trigger", idempotencyKey: null }).ok).toBe(true);
        ctx.clock.advance(7 * MINUTE);
      }
      const refused = createPage(ctx, { accountId: account.id, input: input(), source: "trigger", idempotencyKey: null });
      expect(refused.ok).toBe(false);
      expect(!refused.ok && refused.retryAfterSeconds).toBeGreaterThan(0);
    });

    test("test pages count towards the limit", () => {
      const ctx = testCtx();
      const { account } = seedAccount(ctx);
      for (let i = 0; i < 10; i++) createPage(ctx, { accountId: account.id, input: TEST_PAGE_INPUT, source: "test", idempotencyKey: null });
      expect(createPage(ctx, { accountId: account.id, input: input(), source: "trigger", idempotencyKey: null }).ok).toBe(false);
    });

    test("one account's burst does not limit another account", () => {
      const ctx = testCtx();
      const a = seedAccount(ctx, "a");
      const b = seedAccount(ctx, "b");
      for (let i = 0; i < 11; i++) createPage(ctx, { accountId: a.account.id, input: input(), source: "trigger", idempotencyKey: null });
      expect(createPage(ctx, { accountId: b.account.id, input: input(), source: "trigger", idempotencyKey: null }).ok).toBe(true);
    });
  });

  test("TEST_PAGE_INPUT is a complete, valid input", () => {
    expect(TEST_PAGE_INPUT.message).not.toBe(DEFAULT_MESSAGE);
    expect(TEST_PAGE_INPUT.title).toBe("Pocket Pager");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && bun test test/services/pages.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement `server/src/db/pages.ts`**

```ts
import type { Database } from "bun:sqlite";

export type PageSource = "trigger" | "test";

export type PageRow = {
  id: string;
  public_id: string;
  account_id: string;
  title: string | null;
  message: string;
  details: string | null;
  url: string | null;
  group_key: string | null;
  source: PageSource;
  idempotency_key: string | null;
  created_at: number;
};

export function insertPage(db: Database, row: PageRow): void {
  db.query(
    `INSERT INTO pages (id, public_id, account_id, title, message, details, url, group_key, source, idempotency_key, created_at)
     VALUES ($id, $public_id, $account_id, $title, $message, $details, $url, $group_key, $source, $idempotency_key, $created_at)`,
  ).run(row);
}

export function getPageById(db: Database, id: string): PageRow | null {
  return db.query<PageRow, { id: string }>("SELECT * FROM pages WHERE id = $id").get({ id }) ?? null;
}

export function getPageByPublicId(db: Database, publicId: string): PageRow | null {
  return db.query<PageRow, { publicId: string }>("SELECT * FROM pages WHERE public_id = $publicId").get({ publicId }) ?? null;
}

export function findRecentPageByIdempotencyKey(db: Database, accountId: string, key: string, since: number): PageRow | null {
  return (
    db
      .query<PageRow, { accountId: string; key: string; since: number }>(
        `SELECT * FROM pages WHERE account_id = $accountId AND idempotency_key = $key AND created_at > $since
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get({ accountId, key, since }) ?? null
  );
}

export function countPagesSince(db: Database, accountId: string, since: number): number {
  return db
    .query<{ n: number }, { accountId: string; since: number }>(
      "SELECT COUNT(*) AS n FROM pages WHERE account_id = $accountId AND created_at > $since",
    )
    .get({ accountId, since })!.n;
}

export function oldestPageSince(db: Database, accountId: string, since: number): number | null {
  return (
    db
      .query<{ at: number | null }, { accountId: string; since: number }>(
        "SELECT MIN(created_at) AS at FROM pages WHERE account_id = $accountId AND created_at > $since",
      )
      .get({ accountId, since })?.at ?? null
  );
}

/** Newest first. `before` is the (created_at, id) of the last page already seen. */
export function listPages(
  db: Database,
  accountId: string,
  opts: { since: number; before: { created_at: number; id: string } | null; limit: number },
): PageRow[] {
  if (opts.before) {
    return db
      .query<PageRow, { accountId: string; since: number; beforeAt: number; beforeId: string; limit: number }>(
        `SELECT * FROM pages WHERE account_id = $accountId AND created_at > $since
           AND (created_at < $beforeAt OR (created_at = $beforeAt AND id < $beforeId))
         ORDER BY created_at DESC, id DESC LIMIT $limit`,
      )
      .all({ accountId, since: opts.since, beforeAt: opts.before.created_at, beforeId: opts.before.id, limit: opts.limit });
  }
  return db
    .query<PageRow, { accountId: string; since: number; limit: number }>(
      `SELECT * FROM pages WHERE account_id = $accountId AND created_at > $since
       ORDER BY created_at DESC, id DESC LIMIT $limit`,
    )
    .all({ accountId, since: opts.since, limit: opts.limit });
}
```

- [ ] **Step 4: Implement `server/src/db/jobs.ts`** (Task 13 extends this file)

```ts
import type { Database } from "bun:sqlite";

export type JobStatus = "pending" | "sending" | "submitted" | "failed";

export type JobRow = {
  id: string;
  page_id: string;
  device_id: string | null;
  status: JobStatus;
  attempts: number;
  next_attempt_at: number;
  apns_id: string | null;
  last_error: string | null;
  updated_at: number;
};

export function insertJob(db: Database, row: JobRow): void {
  db.query(
    `INSERT INTO delivery_jobs (id, page_id, device_id, status, attempts, next_attempt_at, apns_id, last_error, updated_at)
     VALUES ($id, $page_id, $device_id, $status, $attempts, $next_attempt_at, $apns_id, $last_error, $updated_at)`,
  ).run(row);
}
```

- [ ] **Step 5: Implement `server/src/services/pages.ts`**

```ts
import { newId, randomToken } from "../auth/tokens";
import type { Config } from "../config";
import type { Ctx } from "../context";
import { listDevicesForAccount } from "../db/devices";
import { insertJob } from "../db/jobs";
import { countPagesSince, findRecentPageByIdempotencyKey, insertPage, oldestPageSince, type PageRow, type PageSource } from "../db/pages";
import type { PageInput } from "./pageInput";

export type { PageRow, PageSource };

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const IDEMPOTENCY_WINDOW_MS = DAY_MS;
export const PAGE_RETENTION_MS = 30 * DAY_MS;

export const TEST_PAGE_INPUT: PageInput = {
  title: "Pocket Pager",
  message: "This is a test page. Your pager works.",
  details: null,
  url: null,
  group: null,
};

export type CreatePageResult =
  | { ok: true; page: PageRow; created: boolean }
  | { ok: false; code: "rate_limited"; retryAfterSeconds: number };

export function viewUrl(config: Config, publicId: string): string {
  return `${config.publicBaseUrl}/v/${publicId}`;
}

function retryAfter(ctx: Ctx, accountId: string, windowMs: number): number {
  const now = ctx.now();
  const oldest = oldestPageSince(ctx.db, accountId, now - windowMs) ?? now;
  return Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
}

export function createPage(
  ctx: Ctx,
  args: { accountId: string; input: PageInput; source: PageSource; idempotencyKey: string | null },
): CreatePageResult {
  return ctx.db.transaction((): CreatePageResult => {
    const now = ctx.now();
    if (args.idempotencyKey) {
      const existing = findRecentPageByIdempotencyKey(ctx.db, args.accountId, args.idempotencyKey, now - IDEMPOTENCY_WINDOW_MS);
      if (existing) return { ok: true, page: existing, created: false };
    }

    const { pagesPerMinute, pagesPerDay } = ctx.config.limits;
    if (countPagesSince(ctx.db, args.accountId, now - MINUTE_MS) >= pagesPerMinute) {
      return { ok: false, code: "rate_limited", retryAfterSeconds: retryAfter(ctx, args.accountId, MINUTE_MS) };
    }
    if (countPagesSince(ctx.db, args.accountId, now - DAY_MS) >= pagesPerDay) {
      return { ok: false, code: "rate_limited", retryAfterSeconds: retryAfter(ctx, args.accountId, DAY_MS) };
    }

    const page: PageRow = {
      id: newId("pg"),
      public_id: randomToken(),
      account_id: args.accountId,
      title: args.input.title,
      message: args.input.message,
      details: args.input.details,
      url: args.input.url,
      group_key: args.input.group,
      source: args.source,
      idempotency_key: args.idempotencyKey,
      created_at: now,
    };
    insertPage(ctx.db, page);
    for (const device of listDevicesForAccount(ctx.db, args.accountId)) {
      insertJob(ctx.db, {
        id: newId("job"),
        page_id: page.id,
        device_id: device.id,
        status: "pending",
        attempts: 0,
        next_attempt_at: now,
        apns_id: null,
        last_error: null,
        updated_at: now,
      });
    }
    return { ok: true, page, created: true };
  })();
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd server && bun test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server
git commit -m "feat(server): transactional page creation with idempotency, rate limits and delivery jobs"
```

---

### Task 12: Logging and the delivery worker

**Files:**
- Create: `server/src/logging.ts`, `server/src/delivery/worker.ts`
- Modify: `server/src/db/jobs.ts` (claim, outcome and health queries), `server/test/helpers.ts` (add `FakeSender`)
- Test: `server/test/logging.test.ts`, `server/test/delivery/worker.test.ts`

**Interfaces:**
- Consumes:
  - `ApnsSender`, `ApnsResult`, `ApnsTarget`, `ApnsMessage` from `delivery/apns`.
  - `viewUrl` from `services/pages`.
  - `deleteDevice` from `db/devices`.
  - `Ctx`.
- Produces:
  - **Logging:**
    - `type LogFields = Record<string, string | number | boolean | null>`.
    - `interface Logger { info(event, fields?): void; error(event, fields?): void }`.
    - `createLogger(sink?: (line: string) => void): Logger`.
    - `redactPath(path: string): string`.
    - `requestLogger(logger): MiddlewareHandler`.
  - **db/jobs.ts:**
    - `claimDueJobs(db, now, limit): JobRow[]`.
    - `getDeliveryContext(db, jobId): DeliveryContext | null`.
    - `markSubmitted(db, id, apnsId, at)` and `markFailed(db, id, reason, at)`.
    - `scheduleRetry(db, id, attempts, nextAt, reason, at)`.
    - `resetSendingJobs(db, at): number`.
    - `oldestOverdueJobAt(db, now): number | null`.
  - **Worker:**
    - `RETRY_DELAYS_MS = [5000, 30000, 120000, 600000]` and `PAGE_TTL_SECONDS = 3600`.
    - `class DeliveryWorker` with:
      - `constructor(deps: Ctx & { sender: ApnsSender; logger: Logger }, options?: { intervalMs?; batchSize?; maxInFlight? })`.
      - `recover(): number`.
      - `tick(): number`.
      - `idle(): Promise<void>`.
      - `wake(): void`.
      - `start(): void`.
      - `stop(timeoutMs?: number): Promise<void>`.
  - **Test helper:** `class FakeSender implements ApnsSender { calls; results: ApnsResult[]; handler? }`.

- [ ] **Step 1: Write the failing logging tests** (`server/test/logging.test.ts`)

```ts
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
```

- [ ] **Step 2: Implement `server/src/logging.ts`**

```ts
import type { MiddlewareHandler } from "hono";

export type LogFields = Record<string, string | number | boolean | null>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export function createLogger(sink: (line: string) => void = (line) => console.log(line)): Logger {
  const write = (level: "info" | "error", event: string, fields: LogFields = {}) =>
    sink(JSON.stringify({ time: new Date().toISOString(), level, event, ...fields }));
  return {
    info: (event, fields) => write("info", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}

/** Trigger tokens (/p/…) and public page ids (/v/…) are secrets: never log them. */
export function redactPath(path: string): string {
  return path.replace(/^\/(p|v)\/[^/]+/, "/$1/***");
}

export function requestLogger(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const started = performance.now();
    await next();
    logger.info("http", {
      method: c.req.method,
      path: redactPath(c.req.path),
      status: c.res.status,
      ms: Math.round(performance.now() - started),
    });
  };
}
```

Run: `cd server && bun test test/logging.test.ts`
Expected: PASS.

- [ ] **Step 3: Add `FakeSender` to `server/test/helpers.ts`**

Add the import:

```ts
import type { ApnsMessage, ApnsResult, ApnsSender, ApnsTarget } from "../src/delivery/apns";
```

Append:

```ts
export class FakeSender implements ApnsSender {
  calls: Array<{ target: ApnsTarget; message: ApnsMessage }> = [];
  /** Consumed in order; when empty, every send succeeds. */
  results: ApnsResult[] = [];
  /** Overrides `results` when set. */
  handler: ((target: ApnsTarget, message: ApnsMessage) => Promise<ApnsResult>) | null = null;

  async send(target: ApnsTarget, message: ApnsMessage): Promise<ApnsResult> {
    this.calls.push({ target, message });
    if (this.handler) return this.handler(target, message);
    return this.results.shift() ?? { kind: "ok", apnsId: `apns-${this.calls.length}` };
  }

  close(): void {}
}
```

- [ ] **Step 4: Write the failing worker tests** (`server/test/delivery/worker.test.ts`)

```ts
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
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `cd server && bun test test/delivery/worker.test.ts`
Expected: FAIL with "Cannot find module '../../src/delivery/worker'".

- [ ] **Step 6: Extend `server/src/db/jobs.ts`**

Add the import:

```ts
import type { ApnsEnv, Platform } from "../config";
```

Append:

```ts
export type DeliveryContext = {
  job_id: string;
  attempts: number;
  device_id: string | null;
  apns_token: string | null;
  apns_env: ApnsEnv | null;
  platform: Platform | null;
  title: string | null;
  message: string;
  group_key: string | null;
  public_id: string;
  url: string | null;
  page_created_at: number;
};

/** Atomically moves due jobs to 'sending' so no job is sent twice in parallel. */
export function claimDueJobs(db: Database, now: number, limit: number): JobRow[] {
  return db
    .query<JobRow, { now: number; limit: number }>(
      `UPDATE delivery_jobs SET status = 'sending', updated_at = $now
       WHERE id IN (
         SELECT id FROM delivery_jobs WHERE status = 'pending' AND next_attempt_at <= $now
         ORDER BY next_attempt_at, id LIMIT $limit
       )
       RETURNING *`,
    )
    .all({ now, limit });
}

export function getDeliveryContext(db: Database, jobId: string): DeliveryContext | null {
  return (
    db
      .query<DeliveryContext, { jobId: string }>(
        `SELECT j.id AS job_id, j.attempts, j.device_id, d.apns_token, d.apns_env, d.platform,
                p.title, p.message, p.group_key, p.public_id, p.url, p.created_at AS page_created_at
         FROM delivery_jobs j
         JOIN pages p ON p.id = j.page_id
         LEFT JOIN devices d ON d.id = j.device_id
         WHERE j.id = $jobId`,
      )
      .get({ jobId }) ?? null
  );
}

export function markSubmitted(db: Database, id: string, apnsId: string, at: number): void {
  db.query("UPDATE delivery_jobs SET status = 'submitted', apns_id = $apnsId, last_error = NULL, updated_at = $at WHERE id = $id").run({
    id,
    apnsId,
    at,
  });
}

export function markFailed(db: Database, id: string, reason: string, at: number): void {
  db.query("UPDATE delivery_jobs SET status = 'failed', last_error = $reason, updated_at = $at WHERE id = $id").run({ id, reason, at });
}

export function scheduleRetry(db: Database, id: string, attempts: number, nextAt: number, reason: string, at: number): void {
  db.query(
    `UPDATE delivery_jobs SET status = 'pending', attempts = $attempts, next_attempt_at = $nextAt,
       last_error = $reason, updated_at = $at WHERE id = $id`,
  ).run({ id, attempts, nextAt, reason, at });
}

/** On boot: jobs a previous process was sending are sent again (at-least-once). */
export function resetSendingJobs(db: Database, at: number): number {
  return db.query("UPDATE delivery_jobs SET status = 'pending', updated_at = $at WHERE status = 'sending'").run({ at }).changes;
}

/** Earliest moment an unfinished job became due, or null when nothing is overdue. */
export function oldestOverdueJobAt(db: Database, now: number): number | null {
  return (
    db
      .query<{ at: number | null }, { now: number }>(
        `SELECT MIN(CASE WHEN status = 'pending' THEN next_attempt_at ELSE updated_at END) AS at
         FROM delivery_jobs
         WHERE (status = 'pending' AND next_attempt_at <= $now) OR status = 'sending'`,
      )
      .get({ now })?.at ?? null
  );
}
```

- [ ] **Step 7: Implement `server/src/delivery/worker.ts`**

```ts
import type { Ctx } from "../context";
import { deleteDevice } from "../db/devices";
import {
  claimDueJobs,
  getDeliveryContext,
  markFailed,
  markSubmitted,
  resetSendingJobs,
  scheduleRetry,
} from "../db/jobs";
import type { Logger } from "../logging";
import { viewUrl } from "../services/pages";
import type { ApnsResult, ApnsSender } from "./apns";

export const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000] as const;
export const PAGE_TTL_SECONDS = 3600;

export type WorkerDeps = Ctx & { sender: ApnsSender; logger: Logger };
export interface WorkerOptions {
  intervalMs?: number;
  batchSize?: number;
  maxInFlight?: number;
}

export class DeliveryWorker {
  private readonly inFlight = new Set<Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly deps: WorkerDeps,
    private readonly options: WorkerOptions = {},
  ) {}

  recover(): number {
    return resetSendingJobs(this.deps.db, this.deps.now());
  }

  /** Claims due jobs and starts sending them. Returns how many were claimed. */
  tick(): number {
    const capacity = (this.options.maxInFlight ?? 100) - this.inFlight.size;
    if (capacity <= 0) return 0;
    const jobs = claimDueJobs(this.deps.db, this.deps.now(), Math.min(capacity, this.options.batchSize ?? 50));
    for (const job of jobs) {
      const running: Promise<void> = this.deliver(job.id)
        .catch((err: unknown) => {
          this.deps.logger.error("delivery_crashed", { name: err instanceof Error ? err.name : "unknown" });
        })
        .finally(() => this.inFlight.delete(running));
      this.inFlight.add(running);
    }
    return jobs.length;
  }

  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  wake(): void {
    queueMicrotask(() => this.tick());
  }

  start(): void {
    const recovered = this.recover();
    if (recovered > 0) this.deps.logger.info("delivery_recovered", { jobs: recovered });
    this.timer = setInterval(() => this.tick(), this.options.intervalMs ?? 500);
    this.tick();
  }

  async stop(timeoutMs = 5_000): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.race([this.idle(), new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
  }

  private async deliver(jobId: string): Promise<void> {
    const { db, now, sender, config, logger } = this.deps;
    const job = getDeliveryContext(db, jobId);
    if (!job) return; // page or account deleted since the claim
    if (!job.apns_token || !job.apns_env || !job.platform || !job.device_id) {
      markFailed(db, jobId, "device_removed", now());
      return;
    }
    const expiresAtSeconds = Math.floor(job.page_created_at / 1000) + PAGE_TTL_SECONDS;
    if (now() >= expiresAtSeconds * 1000) {
      markFailed(db, jobId, "expired", now());
      logger.info("delivery", { outcome: "expired", platform: job.platform });
      return;
    }

    let result: ApnsResult;
    try {
      result = await sender.send(
        { token: job.apns_token, env: job.apns_env, platform: job.platform },
        {
          title: job.title,
          body: job.message,
          threadId: job.group_key ?? "pages",
          publicId: job.public_id,
          viewUrl: viewUrl(config, job.public_id),
          url: job.url,
          expiresAtSeconds,
        },
      );
    } catch {
      result = { kind: "retry", reason: "sender_exception" };
    }

    const at = now();
    const deviceId = job.device_id;
    switch (result.kind) {
      case "ok":
        markSubmitted(db, jobId, result.apnsId, at);
        break;
      case "invalid-token":
        db.transaction(() => {
          markFailed(db, jobId, result.reason, at);
          deleteDevice(db, deviceId);
        })();
        break;
      case "retry": {
        const attempts = job.attempts + 1;
        const delay = RETRY_DELAYS_MS[attempts - 1];
        if (delay === undefined) markFailed(db, jobId, result.reason, at);
        else scheduleRetry(db, jobId, attempts, at + delay, result.reason, at);
        break;
      }
      case "fail":
        markFailed(db, jobId, result.reason, at);
        break;
    }
    logger.info("delivery", { outcome: result.kind, platform: job.platform });
  }
}
```

- [ ] **Step 8: Run all tests**

Run: `cd server && bun test && bun run typecheck`
Expected: PASS, with no type errors.

- [ ] **Step 9: Commit**

```bash
git add server
git commit -m "feat(server): durable delivery worker with retries, expiry, crash recovery and redacted logging"
```

---

### Task 13: Trigger endpoint, app wiring and server entry point

**Files:**
- Create: `server/src/api/responses.ts`, `server/src/api/ipLimiter.ts`, `server/src/api/trigger.ts`, `server/src/server.ts`
- Modify: `server/src/app.ts` (full replacement), `server/src/index.ts` (full replacement), `server/test/app.test.ts` (full replacement), `server/test/helpers.ts` (add `testApp`, `fakeGoogleVerifier`, `fakeGoogleOAuth`)
- Test: `server/test/api/ipLimiter.test.ts`, `server/test/api/trigger.test.ts`, `server/test/server.test.ts`

**Interfaces:**
- Consumes:
  - `findAccountByTriggerToken`, `parseTriggerBody`, `LIMITS`, `createPage`, `viewUrl`.
  - `Logger`, `requestLogger`, `oldestOverdueJobAt`, `DeliveryWorker`.
  - `createApnsSender`, `createGoogleVerifier`, `createGoogleOAuthClient`.
- Produces:
  - **api/responses.ts:**
    - `errorJson(c, status, code, message, headers?)`.
    - `acceptedJson(c, config, page)`, which returns `202 {id, status, view_url}`.
    - `rateLimitedJson(c, retryAfterSeconds, message)`.
  - **api/ipLimiter.ts:**
    - `class FixedWindowLimiter { constructor(limit, windowMs, now?); hit(key): { ok: true } | { ok: false; retryAfterSeconds: number }; size: number }`.
    - `clientIp(c: Context): string`.
  - **app.ts:**
    - `interface AppDeps extends Ctx { logger; worker: { wake(): void }; ipLimiter; google: GoogleVerifier; googleOAuth: GoogleOAuthClient }`.
    - `createApp(deps: AppDeps): Hono`.
  - **server.ts:** `startServer(config, overrides?: { sender?; google?; googleOAuth?; logger?; shutdownTimeoutMs? }): { url: string; db: Database; stop(): Promise<void> }`.
  - **Test helpers:** `testApp(opts?)`, `fakeGoogleVerifier` (accepts `google:<sub>:<email>`) and `fakeGoogleOAuth` (code `bad` fails; otherwise returns `google:<code>:<code>@example.com`).

- [ ] **Step 1: Write the failing limiter tests** (`server/test/api/ipLimiter.test.ts`)

```ts
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
```

- [ ] **Step 2: Implement `server/src/api/ipLimiter.ts`**

```ts
import type { Context } from "hono";

export class FixedWindowLimiter {
  private windowStart = Number.NEGATIVE_INFINITY;
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  hit(key: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
    const now = this.now();
    if (now - this.windowStart >= this.windowMs) {
      this.windowStart = now;
      this.counts.clear();
    }
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    if (count <= this.limit) return { ok: true };
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((this.windowStart + this.windowMs - now) / 1000)) };
  }

  get size(): number {
    return this.counts.size;
  }
}

/**
 * Traefik (siteio) appends the connecting address to X-Forwarded-For, so only the
 * rightmost entry is trustworthy; anything to its left is client-controlled.
 */
export function clientIp(c: Context): string {
  const entries = (c.req.header("x-forwarded-for") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return entries.at(-1) ?? "unknown";
}
```

Run: `cd server && bun test test/api/ipLimiter.test.ts`
Expected: PASS.

- [ ] **Step 3: Implement `server/src/api/responses.ts`**

```ts
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Config } from "../config";
import { type PageRow, viewUrl } from "../services/pages";

export function errorJson(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  headers?: Record<string, string>,
): Response {
  return c.json({ error: { code, message } }, status, headers);
}

export function acceptedJson(c: Context, config: Config, page: PageRow): Response {
  return c.json({ id: page.id, status: "accepted", view_url: viewUrl(config, page.public_id) }, 202);
}

export function rateLimitedJson(c: Context, retryAfterSeconds: number, message: string): Response {
  return errorJson(c, 429, "rate_limited", message, { "Retry-After": String(retryAfterSeconds) });
}
```

- [ ] **Step 4: Add the app test helpers to `server/test/helpers.ts`**

Add these imports:

```ts
import { FixedWindowLimiter } from "../src/api/ipLimiter";
import { type AppDeps, createApp } from "../src/app";
import { AuthError, type GoogleVerifier } from "../src/auth/google";
import type { GoogleOAuthClient } from "../src/auth/googleOAuth";
import { createLogger } from "../src/logging";
```

Append:

```ts
export const fakeGoogleVerifier: GoogleVerifier = {
  async verify(idToken) {
    const match = /^google:([^:]+):(.+)$/.exec(idToken);
    if (!match) throw new AuthError("invalid_id_token");
    return { sub: match[1]!, email: match[2]! };
  },
};

export const fakeGoogleOAuth: GoogleOAuthClient = {
  authorizationUrl: (state) => `https://accounts.example/auth?state=${encodeURIComponent(state)}`,
  async exchangeCode(code) {
    if (code === "bad") throw new AuthError("code_exchange_failed");
    return `google:${code}:${code}@example.com`;
  },
};

export function testApp(opts: { ctx?: ReturnType<typeof testCtx>; config?: Config } = {}) {
  const ctx = opts.ctx ?? testCtx({ config: opts.config });
  const logLines: string[] = [];
  const wakes = { count: 0 };
  const deps: AppDeps = {
    ...ctx,
    logger: createLogger((line) => logLines.push(line)),
    worker: { wake: () => void (wakes.count += 1) },
    ipLimiter: new FixedWindowLimiter(ctx.config.limits.triggerRequestsPerIpPerMinute, 60_000, ctx.now),
    google: fakeGoogleVerifier,
    googleOAuth: fakeGoogleOAuth,
  };
  return { app: createApp(deps), deps, ctx, logLines, wakes };
}
```

- [ ] **Step 5: Write the failing trigger tests** (`server/test/api/trigger.test.ts`)

```ts
import { describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { getPageById } from "../../src/db/pages";
import { DEFAULT_MESSAGE } from "../../src/services/pageInput";
import { seedAccount, testApp, testConfig } from "../helpers";

function post(app: Hono, token: string, init: { body?: string | Uint8Array; headers?: Record<string, string>; ip?: string } = {}) {
  return app.request(`/p/${token}`, {
    method: "POST",
    body: init.body,
    headers: { "x-forwarded-for": init.ip ?? "203.0.113.1", ...init.headers },
  });
}

const pageCount = (t: ReturnType<typeof testApp>) => t.ctx.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM pages").get()!.n;

describe("POST /p/:token", () => {
  test("an empty POST is accepted with the default message and wakes the worker", async () => {
    const t = testApp();
    const { triggerToken } = seedAccount(t.ctx);
    const res = await post(t.app, triggerToken);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { id: string; status: string; view_url: string };
    expect(body.status).toBe("accepted");
    expect(body.view_url).toMatch(/^https:\/\/pager\.test\/v\/[A-Za-z0-9_-]{43}$/);
    expect(getPageById(t.ctx.db, body.id)?.message).toBe(DEFAULT_MESSAGE);
    expect(t.wakes.count).toBe(1);
  });

  test("a JSON body is stored field by field", async () => {
    const t = testApp();
    const { triggerToken } = seedAccount(t.ctx);
    const res = await post(t.app, triggerToken, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Build", message: "Done", details: "**ok**", url: "https://e.com", group: "ci" }),
    });
    const { id } = (await res.json()) as { id: string };
    expect(getPageById(t.ctx.db, id)).toMatchObject({ title: "Build", message: "Done", details: "**ok**", url: "https://e.com", group_key: "ci", source: "trigger" });
  });

  test("unknown and dead tokens get the exact same 404", async () => {
    const t = testApp();
    const { account, triggerToken } = seedAccount(t.ctx);
    t.ctx.db.query("DELETE FROM accounts WHERE id = $id").run({ id: account.id });
    const dead = await post(t.app, triggerToken);
    const unknown = await post(t.app, "x".repeat(43));
    const malformed = await post(t.app, "short");
    expect([dead.status, unknown.status, malformed.status]).toEqual([404, 404, 404]);
    const bodies = await Promise.all([dead.text(), unknown.text(), malformed.text()]);
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toEqual({ error: { code: "not_found", message: "Unknown pager URL." } });
  });

  test("GET (link previews, scanners) never creates a page", async () => {
    const t = testApp();
    const { triggerToken } = seedAccount(t.ctx);
    const res = await t.app.request(`/p/${triggerToken}`);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(pageCount(t)).toBe(0);
  });

  test("a body of exactly 16,384 bytes is accepted and one byte more is 413", async () => {
    const t = testApp();
    const { triggerToken } = seedAccount(t.ctx);
    const base = JSON.stringify({ details: "d".repeat(10_000) });
    const exact = base + " ".repeat(16_384 - base.length);
    const ok = await post(t.app, triggerToken, { headers: { "content-type": "application/json" }, body: exact });
    expect(ok.status).toBe(202);
    const tooBig = await post(t.app, triggerToken, { headers: { "content-type": "application/json" }, body: exact + " " });
    expect(tooBig.status).toBe(413);
    expect(pageCount(t)).toBe(1);
  });

  test("a lying Content-Length over the limit is refused up front", async () => {
    const t = testApp();
    const { triggerToken } = seedAccount(t.ctx);
    const res = await post(t.app, triggerToken, { headers: { "content-length": "99999999" }, body: "hi" });
    expect(res.status).toBe(413);
  });

  test("invalid input is a 400 that does not echo the body", async () => {
    const t = testApp();
    const { triggerToken } = seedAccount(t.ctx);
    const res = await post(t.app, triggerToken, { headers: { "content-type": "application/json" }, body: "{TOP-SECRET" });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text).error.code).toBe("invalid_input");
    expect(text).not.toContain("TOP-SECRET");
  });

  test("the 11th page in a minute is 429 with Retry-After", async () => {
    const t = testApp();
    const { triggerToken } = seedAccount(t.ctx);
    for (let i = 0; i < 10; i++) expect((await post(t.app, triggerToken)).status).toBe(202);
    const res = await post(t.app, triggerToken);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
  });

  test("concurrent retries with one Idempotency-Key create one page", async () => {
    const t = testApp();
    const { triggerToken } = seedAccount(t.ctx);
    const send = () => post(t.app, triggerToken, { headers: { "idempotency-key": "deploy-42" }, body: "x" });
    const [a, b] = await Promise.all([send(), send()]);
    const [ja, jb] = (await Promise.all([a.json(), b.json()])) as Array<{ id: string }>;
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(ja!.id).toBe(jb!.id);
    expect(pageCount(t)).toBe(1);
  });

  test("an Idempotency-Key over 200 characters is rejected", async () => {
    const t = testApp();
    const { triggerToken } = seedAccount(t.ctx);
    const res = await post(t.app, triggerToken, { headers: { "idempotency-key": "k".repeat(201) } });
    expect(res.status).toBe(400);
  });

  test("the per-IP limit cannot be dodged by spoofing the left of X-Forwarded-For", async () => {
    const config = testConfig({ limits: { pagesPerMinute: 1000, pagesPerDay: 1000, triggerRequestsPerIpPerMinute: 30 } });
    const t = testApp({ config });
    const { triggerToken } = seedAccount(t.ctx);
    for (let i = 0; i < 30; i++) expect((await post(t.app, triggerToken, { ip: `10.0.0.${i}, 203.0.113.1` })).status).toBe(202);
    const blocked = await post(t.app, triggerToken, { ip: "10.9.9.9, 203.0.113.1" });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).not.toBeNull();
    expect((await post(t.app, triggerToken, { ip: "198.51.100.7" })).status).toBe(202);
  });

  test("logs never contain the token or the message", async () => {
    const t = testApp();
    const { triggerToken } = seedAccount(t.ctx);
    await post(t.app, triggerToken, { body: "TOP-SECRET-MESSAGE" });
    await post(t.app, triggerToken, { headers: { "content-type": "application/json" }, body: "{TOP-SECRET-JSON" });
    const logs = t.logLines.join("\n");
    expect(logs).toContain("/p/***");
    expect(logs).not.toContain(triggerToken);
    expect(logs).not.toContain("TOP-SECRET");
  });

  test("a database failure is a generic 500, logged without details", async () => {
    const t = testApp();
    const { triggerToken } = seedAccount(t.ctx);
    t.ctx.db.close();
    const res = await post(t.app, triggerToken);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "internal", message: "Something went wrong. Try again." } });
    expect(t.logLines.join("\n")).toContain("unhandled_error");
  });
});
```

- [ ] **Step 6: Replace `server/test/app.test.ts`**

```ts
import { expect, test } from "bun:test";
import { createPage } from "../src/services/pages";
import { seedAccount, seedDevice, testApp } from "./helpers";

test("GET /healthz reports no overdue work when idle", async () => {
  const t = testApp();
  const res = await t.app.request("/healthz");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, oldest_pending_ms: 0 });
});

test("GET /healthz reports how long the oldest due job has waited", async () => {
  const t = testApp();
  const { account } = seedAccount(t.ctx);
  seedDevice(t.ctx, account.id);
  createPage(t.ctx, { accountId: account.id, input: { title: null, message: "x", details: null, url: null, group: null }, source: "trigger", idempotencyKey: null });
  t.ctx.clock.advance(5000);
  expect(await (await t.app.request("/healthz")).json()).toEqual({ ok: true, oldest_pending_ms: 5000 });
});

test("unknown routes are JSON 404s", async () => {
  const res = await testApp().app.request("/nope");
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: { code: "not_found", message: "Not found." } });
});
```

- [ ] **Step 7: Run the tests to verify they fail**

Run: `cd server && bun test test/api test/app.test.ts`
Expected: FAIL. `createApp` does not accept deps yet, and `src/api/trigger` does not exist.

- [ ] **Step 8: Implement `server/src/api/trigger.ts`**

```ts
import { Hono } from "hono";
import type { AppDeps } from "../app";
import { findAccountByTriggerToken } from "../services/accounts";
import { LIMITS, parseTriggerBody } from "../services/pageInput";
import { createPage } from "../services/pages";
import { clientIp } from "./ipLimiter";
import { acceptedJson, errorJson, rateLimitedJson } from "./responses";

export function triggerRoutes(deps: AppDeps): Hono {
  const routes = new Hono();

  routes.post("/p/:token", async (c) => {
    const ip = deps.ipLimiter.hit(clientIp(c));
    if (!ip.ok) return rateLimitedJson(c, ip.retryAfterSeconds, "Too many requests. Slow down.");

    const tooLarge = () => errorJson(c, 413, "payload_too_large", `Request body must be at most ${LIMITS.bodyBytes} bytes.`);
    if (Number(c.req.header("content-length") ?? 0) > LIMITS.bodyBytes) return tooLarge();

    const account = findAccountByTriggerToken(deps, c.req.param("token"));
    if (!account) return errorJson(c, 404, "not_found", "Unknown pager URL.");

    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.length > LIMITS.bodyBytes) return tooLarge();

    const idempotencyKey = c.req.header("idempotency-key")?.trim() || null;
    if (idempotencyKey && idempotencyKey.length > LIMITS.idempotencyKey) {
      return errorJson(c, 400, "invalid_input", `Idempotency-Key must be at most ${LIMITS.idempotencyKey} characters.`);
    }

    const parsed = parseTriggerBody(c.req.header("content-type"), body);
    if (!parsed.ok) return errorJson(c, 400, "invalid_input", parsed.message);

    const result = createPage(deps, { accountId: account.id, input: parsed.value, source: "trigger", idempotencyKey });
    if (!result.ok) return rateLimitedJson(c, result.retryAfterSeconds, "Too many pages. Try again later.");
    deps.worker.wake();
    return acceptedJson(c, deps.config, result.page);
  });

  routes.all("/p/:token", (c) => errorJson(c, 405, "method_not_allowed", "Use POST to send a page.", { Allow: "POST" }));

  return routes;
}
```

- [ ] **Step 9: Replace `server/src/app.ts`**

```ts
import { Hono } from "hono";
import type { FixedWindowLimiter } from "./api/ipLimiter";
import { errorJson } from "./api/responses";
import { triggerRoutes } from "./api/trigger";
import type { GoogleVerifier } from "./auth/google";
import type { GoogleOAuthClient } from "./auth/googleOAuth";
import type { Ctx } from "./context";
import { oldestOverdueJobAt } from "./db/jobs";
import { type Logger, requestLogger } from "./logging";

export interface AppDeps extends Ctx {
  logger: Logger;
  worker: { wake(): void };
  ipLimiter: FixedWindowLimiter;
  google: GoogleVerifier;
  googleOAuth: GoogleOAuthClient;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.use("*", requestLogger(deps.logger));
  app.onError((err, c) => {
    deps.logger.error("unhandled_error", { name: err.name });
    return errorJson(c, 500, "internal", "Something went wrong. Try again.");
  });
  app.notFound((c) => errorJson(c, 404, "not_found", "Not found."));

  app.get("/healthz", (c) => {
    const now = deps.now();
    const oldest = oldestOverdueJobAt(deps.db, now);
    return c.json({ ok: true, oldest_pending_ms: oldest === null ? 0 : now - oldest });
  });
  app.route("/", triggerRoutes(deps));
  return app;
}
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `cd server && bun test test/api test/app.test.ts`
Expected: PASS.

- [ ] **Step 11: Write the failing server wiring tests** (`server/test/server.test.ts`)

```ts
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
```

- [ ] **Step 12: Implement `server/src/server.ts` and replace `server/src/index.ts`**

```ts
// server/src/server.ts
import type { Database } from "bun:sqlite";
import { FixedWindowLimiter } from "./api/ipLimiter";
import { createApp } from "./app";
import { createGoogleVerifier, type GoogleVerifier } from "./auth/google";
import { createGoogleOAuthClient, type GoogleOAuthClient } from "./auth/googleOAuth";
import type { Config } from "./config";
import { openDatabase } from "./db/database";
import { type ApnsSender, createApnsSender } from "./delivery/apns";
import { DeliveryWorker } from "./delivery/worker";
import { createLogger, type Logger } from "./logging";

const MAX_REQUEST_BODY_BYTES = 64 * 1024;

export interface RunningServer {
  url: string;
  db: Database;
  stop(): Promise<void>;
}

export function startServer(
  config: Config,
  overrides: {
    sender?: ApnsSender;
    google?: GoogleVerifier;
    googleOAuth?: GoogleOAuthClient;
    logger?: Logger;
    shutdownTimeoutMs?: number;
  } = {},
): RunningServer {
  const now = Date.now;
  const db = openDatabase(config.databasePath);
  const logger = overrides.logger ?? createLogger();
  const sender = overrides.sender ?? createApnsSender(config.apns);
  const worker = new DeliveryWorker({ db, config, now, sender, logger });
  const app = createApp({
    db,
    config,
    now,
    logger,
    worker,
    ipLimiter: new FixedWindowLimiter(config.limits.triggerRequestsPerIpPerMinute, 60_000, now),
    google:
      overrides.google ??
      createGoogleVerifier([config.google.webClientId, config.google.iosClientId, config.google.macosClientId]),
    googleOAuth:
      overrides.googleOAuth ??
      createGoogleOAuthClient({
        clientId: config.google.webClientId,
        clientSecret: config.google.webClientSecret,
        redirectUri: `${config.publicBaseUrl}/auth/google/callback`,
      }),
  });

  worker.start();
  const server = Bun.serve({ port: config.port, fetch: app.fetch, maxRequestBodySize: MAX_REQUEST_BODY_BYTES });
  logger.info("server_started", { port: server.port ?? 0 });

  return {
    url: `http://localhost:${server.port}`,
    db,
    async stop() {
      server.stop(true);
      await worker.stop(overrides.shutdownTimeoutMs);
      sender.close();
      db.close();
    },
  };
}
```

```ts
// server/src/index.ts
import { loadConfig } from "./config";
import { startServer } from "./server";

const running = startServer(loadConfig());

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    await running.stop();
    process.exit(0);
  });
}
```

- [ ] **Step 13: Run all tests and the type check**

Run: `cd server && bun test && bun run typecheck`
Expected: PASS, with no type errors.

- [ ] **Step 14: Commit**

```bash
git add server
git commit -m "feat(server): trigger endpoint with limits and idempotency, app wiring and server entry point"
```

---

### Task 14: App API

**Files:**
- Create: `server/src/api/appApi.ts`
- Modify: `server/src/services/pages.ts` (add `listPagesForAccount`), `server/src/app.ts` (mount `/api`)
- Test: `server/test/api/appApi.test.ts`

**Interfaces:**
- Consumes:
  - `GoogleVerifier`, `AuthError`.
  - `findOrCreateAccount`, `createSession`, `resolveSession`, `revokeSession`.
  - `parseDeviceInput`, `registerCurrentDevice`.
  - `createPage`, `TEST_PAGE_INPUT`.
  - `acceptedJson`, `errorJson`, `rateLimitedJson`.
- Produces:
  - `listPagesForAccount(ctx, accountId, opts: { beforeId: string | null; limit: number }): { ok: true; pages: PageRow[]; nextBefore: string | null } | { ok: false; message: string }`.
  - `appApiRoutes(deps): Hono`, mounted at `/api`.
- **JSON contract** used by PagerKit (Task 18):
  - `POST /api/auth/google {id_token}` → `200 {session_token, email}`.
  - `POST /api/auth/logout` → `204`.
  - `PUT /api/devices/current {apns_token, platform, model, apns_env}` → `200 {id}`.
  - `GET /api/pages?before=&limit=` → `200 {pages: [{id, title, message, url, view_url, source, created_at}], next_before}`, with `created_at` as ISO 8601 including milliseconds.
  - `POST /api/test` → `202 {id, status, view_url}`.

- [ ] **Step 1: Write the failing tests** (`server/test/api/appApi.test.ts`)

```ts
import { describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { listDevicesForAccount } from "../../src/db/devices";
import { getAccountByGoogleSub } from "../../src/db/accounts";
import { createSession } from "../../src/services/sessions";
import { createPage } from "../../src/services/pages";
import { seedAccount, testApp, testConfig } from "../helpers";

const TOKEN = "c3".repeat(32);

async function signIn(app: Hono, idToken = "google:sub-1:a@example.com"): Promise<string> {
  const res = await app.request("/api/auth/google", { method: "POST", body: JSON.stringify({ id_token: idToken }), headers: { "content-type": "application/json" } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { session_token: string }).session_token;
}

const authed = (token: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers as Record<string, string>) },
});

function addPage(t: ReturnType<typeof testApp>, accountId: string, message: string) {
  const r = createPage(t.ctx, { accountId, input: { title: null, message, details: null, url: null, group: null }, source: "trigger", idempotencyKey: null });
  if (!r.ok) throw new Error("rate limited");
  return r.page;
}

describe("POST /api/auth/google", () => {
  test("creates the account on first sign-in and reuses it after", async () => {
    const t = testApp();
    const first = await signIn(t.app);
    const second = await signIn(t.app);
    expect(first).not.toBe(second);
    expect(getAccountByGoogleSub(t.ctx.db, "sub-1")?.email).toBe("a@example.com");
    expect(t.ctx.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM accounts").get()!.n).toBe(1);
  });

  test("returns the email with the session", async () => {
    const t = testApp();
    const res = await t.app.request("/api/auth/google", { method: "POST", body: JSON.stringify({ id_token: "google:s:me@example.com" }) });
    expect(((await res.json()) as { email: string }).email).toBe("me@example.com");
  });

  test("an unverifiable Google token is 401", async () => {
    const res = await testApp().app.request("/api/auth/google", { method: "POST", body: JSON.stringify({ id_token: "forged" }) });
    expect(res.status).toBe(401);
  });

  for (const [name, body] of [
    ["no body", undefined],
    ["non-JSON", "id_token=abc"],
    ["a numeric token", JSON.stringify({ id_token: 5 })],
    ["an empty token", JSON.stringify({ id_token: "" })],
    ["a JSON array", "[]"],
  ] as const) {
    test(`${name} is 400`, async () => {
      const res = await testApp().app.request("/api/auth/google", { method: "POST", body });
      expect(res.status).toBe(400);
    });
  }
});

describe("bearer authentication", () => {
  test("missing, malformed and unknown tokens are 401", async () => {
    const t = testApp();
    for (const header of [undefined, "Bearer", "Basic abc", `Bearer ${"z".repeat(43)}`]) {
      const res = await t.app.request("/api/pages", { headers: header ? { authorization: header } : {} });
      expect(res.status).toBe(401);
    }
  });

  test("a web session token cannot be used as a bearer token", async () => {
    const t = testApp();
    const { account } = seedAccount(t.ctx);
    const web = createSession(t.ctx, account.id, "web");
    expect((await t.app.request("/api/pages", authed(web.token))).status).toBe(401);
  });
});

describe("devices", () => {
  test("a registered device receives jobs for new pages", async () => {
    const t = testApp();
    const token = await signIn(t.app);
    const res = await t.app.request("/api/devices/current", authed(token, { method: "PUT", body: JSON.stringify({ apns_token: TOKEN, platform: "ios", model: "iPhone17,1", apns_env: "sandbox" }) }));
    expect(res.status).toBe(200);
    expect(await t.app.request("/api/test", authed(token, { method: "POST" })).then((r) => r.status)).toBe(202);
    expect(t.ctx.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM delivery_jobs").get()!.n).toBe(1);
  });

  test("invalid device bodies are 400", async () => {
    const t = testApp();
    const token = await signIn(t.app);
    const res = await t.app.request("/api/devices/current", authed(token, { method: "PUT", body: JSON.stringify({ apns_token: "nope", platform: "ios", model: "x", apns_env: "sandbox" }) }));
    expect(res.status).toBe(400);
  });

  test("logout revokes the session and removes the device", async () => {
    const t = testApp();
    const token = await signIn(t.app);
    await t.app.request("/api/devices/current", authed(token, { method: "PUT", body: JSON.stringify({ apns_token: TOKEN, platform: "ios", model: "x", apns_env: "sandbox" }) }));
    const account = getAccountByGoogleSub(t.ctx.db, "sub-1")!;
    expect((await t.app.request("/api/auth/logout", authed(token, { method: "POST" }))).status).toBe(204);
    expect(listDevicesForAccount(t.ctx.db, account.id)).toHaveLength(0);
    expect((await t.app.request("/api/pages", authed(token))).status).toBe(401);
  });
});

describe("GET /api/pages", () => {
  test("returns only the caller's pages, newest first, in the documented shape", async () => {
    const t = testApp();
    const token = await signIn(t.app);
    const mine = getAccountByGoogleSub(t.ctx.db, "sub-1")!;
    const other = seedAccount(t.ctx, "someone-else");
    addPage(t, other.account.id, "not yours");
    addPage(t, mine.id, "older");
    t.ctx.clock.advance(1000);
    const newest = addPage(t, mine.id, "newer");
    const body = (await (await t.app.request("/api/pages", authed(token))).json()) as { pages: Array<Record<string, unknown>>; next_before: string | null };
    expect(body.pages.map((p) => p.message)).toEqual(["newer", "older"]);
    expect(body.pages[0]).toEqual({
      id: newest.id,
      title: null,
      message: "newer",
      url: null,
      view_url: `https://pager.test/v/${newest.public_id}`,
      source: "trigger",
      created_at: new Date(newest.created_at).toISOString(),
    });
    expect(body.next_before).toBeNull();
  });

  test("paginates 120 pages without gaps or duplicates", async () => {
    const t = testApp({ config: testConfig({ limits: { pagesPerMinute: 1000, pagesPerDay: 1000, triggerRequestsPerIpPerMinute: 30 } }) });
    const token = await signIn(t.app);
    const account = getAccountByGoogleSub(t.ctx.db, "sub-1")!;
    for (let i = 0; i < 120; i++) {
      addPage(t, account.id, `m${i}`);
      if (i % 3 === 0) t.ctx.clock.advance(1); // also exercise identical timestamps
    }
    const seen: string[] = [];
    let before: string | null = null;
    do {
      const query: string = before ? `?before=${before}` : "";
      const body = (await (await t.app.request(`/api/pages${query}`, authed(token))).json()) as { pages: Array<{ id: string }>; next_before: string | null };
      seen.push(...body.pages.map((p) => p.id));
      before = body.next_before;
    } while (before);
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
  });

  test("bad limits and foreign or unknown cursors are 400", async () => {
    const t = testApp();
    const token = await signIn(t.app);
    const other = seedAccount(t.ctx, "other");
    const foreign = addPage(t, other.account.id, "x");
    for (const query of ["?limit=0", "?limit=101", "?limit=abc", "?limit=1.5", `?before=${foreign.id}`, "?before=pg_missing"]) {
      expect((await t.app.request(`/api/pages${query}`, authed(token))).status).toBe(400);
    }
  });

  test("pages older than 30 days are not returned", async () => {
    const t = testApp();
    const token = await signIn(t.app);
    const account = getAccountByGoogleSub(t.ctx.db, "sub-1")!;
    addPage(t, account.id, "ancient");
    t.ctx.clock.advance(30 * 24 * 60 * 60 * 1000 + 1);
    const body = (await (await t.app.request("/api/pages", authed(token))).json()) as { pages: unknown[] };
    expect(body.pages).toHaveLength(0);
  });
});

describe("POST /api/test", () => {
  test("creates a test page, wakes the worker and respects the rate limit", async () => {
    const t = testApp();
    const token = await signIn(t.app);
    const res = await t.app.request("/api/test", authed(token, { method: "POST" }));
    expect(res.status).toBe(202);
    expect(t.wakes.count).toBe(1);
    for (let i = 0; i < 9; i++) await t.app.request("/api/test", authed(token, { method: "POST" }));
    const limited = await t.app.request("/api/test", authed(token, { method: "POST" }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && bun test test/api/appApi.test.ts`
Expected: FAIL, because the routes don't exist yet (404s instead of the expected status codes).

- [ ] **Step 3: Add `listPagesForAccount` to `server/src/services/pages.ts`**

Change the `db/pages` import to:

```ts
import {
  countPagesSince,
  findRecentPageByIdempotencyKey,
  getPageById,
  insertPage,
  listPages,
  oldestPageSince,
  type PageRow,
  type PageSource,
} from "../db/pages";
```

Append:

```ts
export function listPagesForAccount(
  ctx: Ctx,
  accountId: string,
  opts: { beforeId: string | null; limit: number },
): { ok: true; pages: PageRow[]; nextBefore: string | null } | { ok: false; message: string } {
  let before: { created_at: number; id: string } | null = null;
  if (opts.beforeId) {
    const cursor = getPageById(ctx.db, opts.beforeId);
    if (!cursor || cursor.account_id !== accountId) return { ok: false, message: "Unknown cursor." };
    before = { created_at: cursor.created_at, id: cursor.id };
  }
  const pages = listPages(ctx.db, accountId, { since: ctx.now() - PAGE_RETENTION_MS, before, limit: opts.limit });
  return { ok: true, pages, nextBefore: pages.length === opts.limit ? pages.at(-1)!.id : null };
}
```

- [ ] **Step 4: Implement `server/src/api/appApi.ts`**

```ts
import { Hono } from "hono";
import type { AppDeps } from "../app";
import { AuthError } from "../auth/google";
import type { Config } from "../config";
import { findOrCreateAccount, type Identity } from "../services/accounts";
import { parseDeviceInput, registerCurrentDevice } from "../services/devices";
import { createPage, listPagesForAccount, type PageRow, TEST_PAGE_INPUT, viewUrl } from "../services/pages";
import { createSession, resolveSession, revokeSession, type SessionRow } from "../services/sessions";
import { acceptedJson, errorJson, rateLimitedJson } from "./responses";

type Env = { Variables: { session: SessionRow } };

function pageJson(config: Config, page: PageRow) {
  return {
    id: page.id,
    title: page.title,
    message: page.message,
    url: page.url,
    view_url: viewUrl(config, page.public_id),
    source: page.source,
    created_at: new Date(page.created_at).toISOString(),
  };
}

export function appApiRoutes(deps: AppDeps): Hono<Env> {
  const api = new Hono<Env>();

  // Registered before the auth middleware: this is the only unauthenticated route.
  api.post("/auth/google", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { id_token?: unknown } | null;
    if (!body || typeof body.id_token !== "string" || body.id_token === "") {
      return errorJson(c, 400, "invalid_input", "id_token is required.");
    }
    let identity: Identity;
    try {
      identity = await deps.google.verify(body.id_token);
    } catch (err) {
      if (err instanceof AuthError) return errorJson(c, 401, "unauthorized", "Google sign-in could not be verified.");
      throw err;
    }
    const account = findOrCreateAccount(deps, identity);
    const { token } = createSession(deps, account.id, "app");
    return c.json({ session_token: token, email: account.email });
  });

  api.use("*", async (c, next) => {
    const match = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "");
    const session = match ? resolveSession(deps, match[1]!, "app") : null;
    if (!session) return errorJson(c, 401, "unauthorized", "Sign in again.");
    c.set("session", session);
    await next();
  });

  api.post("/auth/logout", (c) => {
    revokeSession(deps, c.get("session"));
    return c.body(null, 204);
  });

  api.put("/devices/current", async (c) => {
    const parsed = parseDeviceInput(await c.req.json().catch(() => null));
    if (!parsed.ok) return errorJson(c, 400, "invalid_input", parsed.message);
    const device = registerCurrentDevice(deps, c.get("session"), parsed.value);
    return c.json({ id: device.id });
  });

  api.get("/pages", (c) => {
    const rawLimit = c.req.query("limit");
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return errorJson(c, 400, "invalid_input", "limit must be an integer from 1 to 100.");
    }
    const result = listPagesForAccount(deps, c.get("session").account_id, { beforeId: c.req.query("before") || null, limit });
    if (!result.ok) return errorJson(c, 400, "invalid_input", result.message);
    return c.json({ pages: result.pages.map((page) => pageJson(deps.config, page)), next_before: result.nextBefore });
  });

  api.post("/test", (c) => {
    const result = createPage(deps, { accountId: c.get("session").account_id, input: TEST_PAGE_INPUT, source: "test", idempotencyKey: null });
    if (!result.ok) return rateLimitedJson(c, result.retryAfterSeconds, "Too many pages. Try again later.");
    deps.worker.wake();
    return acceptedJson(c, deps.config, result.page);
  });

  return api;
}
```

- [ ] **Step 5: Mount it in `server/src/app.ts`**

Add the import `import { appApiRoutes } from "./api/appApi";`. After `app.route("/", triggerRoutes(deps));`, add:

```ts
  app.route("/api", appApiRoutes(deps));
```

- [ ] **Step 6: Run all tests**

Run: `cd server && bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server
git commit -m "feat(server): app API for sign-in, device registration, history and test pages"
```

---

### Task 15: Web sign-in and dashboard

**Files:**
- Create: `server/src/web/http.ts`, `server/src/web/session.ts`, `server/src/web/layout.tsx`, `server/src/web/authRoutes.tsx`, `server/src/web/dashboard.tsx`
- Create: `server/public/style.css`, `server/public/app.js`
- Modify: `server/src/services/accounts.ts` (add `getAccount`), `server/src/services/devices.ts` (add `listDevices`), `server/src/app.ts` (security headers, static files, web routes)
- Test: `server/test/web/dashboard.test.ts`

**Interfaces:**
- Consumes: `randomToken`, `constantTimeEqual`, `findOrCreateAccount`, `triggerUrl`, `createSession`, `resolveSession`, `revokeSession`, `createPage`, `TEST_PAGE_INPUT`, `listPagesForAccount`, `viewUrl`.
- Produces:
  - **web/http.ts:** `CSP`, `securityHeaders(): MiddlewareHandler`, `renderHtml(c, node, status?)`.
  - **web/session.ts:** `SESSION_COOKIE`, `STATE_COOKIE`, `setSessionCookie`, `clearSessionCookie`, `setStateCookie`, `takeStateCookie`, `currentWebSession(ctx, c): { session; csrf } | null`, `csrfTokenFor(token)`, `hasValidCsrf(c, web)`.
  - **web/layout.tsx:** `Layout` and `MessagePage`, both used by Task 16.
  - **Route functions:** `webAuthRoutes(deps)` and `dashboardRoutes(deps)`.
  - **Service functions:** `getAccount(ctx, id)` and `listDevices(ctx, accountId)`.

- [ ] **Step 1: Write the failing tests** (`server/test/web/dashboard.test.ts`)

```ts
import { describe, expect, test } from "bun:test";
import type { Hono } from "hono";
import { getAccountByGoogleSub } from "../../src/db/accounts";
import { triggerUrl } from "../../src/services/accounts";
import { createSession } from "../../src/services/sessions";
import { CSP } from "../../src/web/http";
import { seedAccount, testApp } from "../helpers";

function cookieFrom(res: Response, name: string): string | null {
  for (const header of res.headers.getSetCookie()) {
    const match = new RegExp(`^${name}=([^;]*)`).exec(header);
    if (match?.[1]) return match[1];
  }
  return null;
}

async function signIn(app: Hono, code = "user1") {
  const start = await app.request("/auth/google");
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const stateCookie = cookieFrom(start, "pp_oauth_state")!;
  const res = await app.request(`/auth/google/callback?state=${encodeURIComponent(state)}&code=${code}`, {
    headers: { cookie: `pp_oauth_state=${stateCookie}` },
  });
  return { res, session: cookieFrom(res, "pp_session") };
}

const home = (app: Hono, session: string) => app.request("/", { headers: { cookie: `pp_session=${session}` } });
const csrfFrom = (html: string) => /name="_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";

function postForm(app: Hono, path: string, session: string, fields: Record<string, string>) {
  return app.request(path, {
    method: "POST",
    body: new URLSearchParams(fields).toString(),
    headers: { cookie: `pp_session=${session}`, "content-type": "application/x-www-form-urlencoded" },
  });
}

describe("signed out", () => {
  test("the home page offers Google sign-in under a strict CSP", async () => {
    const res = await testApp().app.request("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('href="/auth/google"');
    expect(res.headers.get("content-security-policy")).toBe(CSP);
    expect(CSP).not.toContain("unsafe-inline");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  test("static assets are served", async () => {
    const t = testApp();
    expect((await t.app.request("/static/app.js")).status).toBe(200);
    expect((await t.app.request("/static/style.css")).status).toBe(200);
  });
});

describe("Google sign-in", () => {
  test("a matching state creates the account and an HttpOnly session cookie", async () => {
    const t = testApp();
    const { res, session } = await signIn(t.app);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    const setCookie = res.headers.getSetCookie().find((h) => h.startsWith("pp_session="))!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Secure");
    const account = getAccountByGoogleSub(t.ctx.db, "user1")!;
    const html = await (await home(t.app, session!)).text();
    expect(html).toContain(triggerUrl(t.ctx, account.id));
    expect(html).toContain("user1@example.com");
    expect(html).toContain("No devices yet");
  });

  test("a mismatched, missing or absent state never signs in", async () => {
    const t = testApp();
    const start = await t.app.request("/auth/google");
    const stateCookie = cookieFrom(start, "pp_oauth_state")!;
    const attempts = [
      t.app.request("/auth/google/callback?state=forged&code=user1", { headers: { cookie: `pp_oauth_state=${stateCookie}` } }),
      t.app.request(`/auth/google/callback?state=${stateCookie}&code=user1`),
      t.app.request("/auth/google/callback?code=user1", { headers: { cookie: `pp_oauth_state=${stateCookie}` } }),
      t.app.request(`/auth/google/callback?state=${stateCookie}`, { headers: { cookie: `pp_oauth_state=${stateCookie}` } }),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(400);
      expect(cookieFrom(res, "pp_session")).toBeNull();
    }
    expect(t.ctx.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM accounts").get()!.n).toBe(0);
  });

  test("Google errors and failed code exchanges do not sign in", async () => {
    const t = testApp();
    const cancelled = await t.app.request("/auth/google/callback?error=access_denied");
    expect(cancelled.status).toBe(303);
    expect(cookieFrom(cancelled, "pp_session")).toBeNull();
    const { res, session } = await signIn(t.app, "bad");
    expect(res.status).toBe(401);
    expect(session).toBeNull();
  });

  test("an app session token is not a web session", async () => {
    const t = testApp();
    const { account } = seedAccount(t.ctx);
    const app = createSession(t.ctx, account.id, "app");
    expect(await (await home(t.app, app.token)).text()).toContain('href="/auth/google"');
  });
});

describe("dashboard forms", () => {
  test("Test my pager requires the CSRF token", async () => {
    const t = testApp();
    const { session } = await signIn(t.app);
    const csrf = csrfFrom(await (await home(t.app, session!)).text());
    expect(csrf).not.toBe("");

    expect((await postForm(t.app, "/test", session!, {})).status).toBe(403);
    expect((await postForm(t.app, "/test", session!, { _csrf: "wrong" })).status).toBe(403);
    expect(t.ctx.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM pages").get()!.n).toBe(0);

    const ok = await postForm(t.app, "/test", session!, { _csrf: csrf });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/?sent=1");
    expect(t.wakes.count).toBe(1);
    expect(t.ctx.db.query<{ source: string }, []>("SELECT source FROM pages").get()!.source).toBe("test");
  });

  test("Test my pager while signed out does nothing", async () => {
    const t = testApp();
    const res = await t.app.request("/test", { method: "POST" });
    expect(res.status).toBe(303);
    expect(t.ctx.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM pages").get()!.n).toBe(0);
  });

  test("sign-out needs the CSRF token, then really ends the session", async () => {
    const t = testApp();
    const { session } = await signIn(t.app);
    const csrf = csrfFrom(await (await home(t.app, session!)).text());
    await postForm(t.app, "/auth/logout", session!, {});
    expect(await (await home(t.app, session!)).text()).not.toContain('href="/auth/google"');
    await postForm(t.app, "/auth/logout", session!, { _csrf: csrf });
    expect(await (await home(t.app, session!)).text()).toContain('href="/auth/google"');
  });
});

describe("recent pages", () => {
  test("shows only the signed-in account's pages, escaped, linking to the public view", async () => {
    const t = testApp();
    const { session } = await signIn(t.app);
    const mine = getAccountByGoogleSub(t.ctx.db, "user1")!;
    const other = seedAccount(t.ctx, "other");
    const mineToken = triggerUrl(t.ctx, mine.id).split("/p/")[1]!;
    await t.app.request(`/p/${mineToken}`, { method: "POST", body: "<script>alert(1)</script>" });
    await t.app.request(`/p/${other.triggerToken}`, { method: "POST", body: "someone else's page" });
    const html = await (await home(t.app, session!)).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("someone else");
    expect(html).toMatch(/href="https:\/\/pager\.test\/v\/[A-Za-z0-9_-]{43}"/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && bun test test/web/dashboard.test.ts`
Expected: FAIL with "Cannot find module '../../src/web/http'".

- [ ] **Step 3: Add the small service helpers**

In `server/src/services/accounts.ts`, append:

```ts
export function getAccount(ctx: Ctx, accountId: string): AccountRow | null {
  return getAccountById(ctx.db, accountId);
}
```

In `server/src/services/devices.ts`, change the `db/devices` import to include `listDevicesForAccount`, then append:

```ts
export function listDevices(ctx: Ctx, accountId: string): DeviceRow[] {
  return listDevicesForAccount(ctx.db, accountId);
}
```

- [ ] **Step 4: Implement `server/src/web/http.ts` and `server/src/web/session.ts`**

```ts
// server/src/web/http.ts
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'";

export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.res.headers.set("Content-Security-Policy", CSP);
    c.res.headers.set("Referrer-Policy", "no-referrer");
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    c.res.headers.set("X-Frame-Options", "DENY");
  };
}

/** Renders a Hono JSX element as a full HTML document. */
export async function renderHtml(c: Context, node: unknown, status: ContentfulStatusCode = 200): Promise<Response> {
  return c.html(`<!doctype html>${String(await node)}`, status);
}
```

```ts
// server/src/web/session.ts
import { createHash } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { constantTimeEqual } from "../auth/tokens";
import type { Config } from "../config";
import type { Ctx } from "../context";
import { resolveSession, SESSION_IDLE_TTL_MS, type SessionRow } from "../services/sessions";

export const SESSION_COOKIE = "pp_session";
export const STATE_COOKIE = "pp_oauth_state";

const isSecure = (config: Config) => config.publicBaseUrl.startsWith("https://");

export function setSessionCookie(c: Context, config: Config, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isSecure(config),
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(SESSION_IDLE_TTL_MS / 1000),
  });
}

export function clearSessionCookie(c: Context, config: Config): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: isSecure(config) });
}

export function setStateCookie(c: Context, config: Config, state: string): void {
  setCookie(c, STATE_COOKIE, state, { httpOnly: true, secure: isSecure(config), sameSite: "Lax", path: "/auth", maxAge: 600 });
}

/** Reads the OAuth state cookie and clears it: a state is single-use. */
export function takeStateCookie(c: Context, config: Config): string | undefined {
  const value = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: "/auth", secure: isSecure(config) });
  return value;
}

export interface WebSession {
  session: SessionRow;
  csrf: string;
}

export function csrfTokenFor(sessionToken: string): string {
  return createHash("sha256").update(`csrf:${sessionToken}`).digest("base64url");
}

export function currentWebSession(ctx: Ctx, c: Context): WebSession | null {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const session = resolveSession(ctx, token, "web");
  return session ? { session, csrf: csrfTokenFor(token) } : null;
}

export async function hasValidCsrf(c: Context, web: WebSession): Promise<boolean> {
  const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
  return typeof body._csrf === "string" && constantTimeEqual(body._csrf, web.csrf);
}
```

- [ ] **Step 5: Implement `server/src/web/layout.tsx`**

```tsx
import type { Child } from "hono/jsx";

export function Layout(props: { title: string; children?: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>{props.title}</title>
        <link rel="stylesheet" href="/static/style.css" />
        <script src="/static/app.js" defer></script>
      </head>
      <body>
        <main>{props.children}</main>
      </body>
    </html>
  );
}

export function MessagePage(props: { title: string; text: string }) {
  return (
    <Layout title={props.title}>
      <h1>{props.title}</h1>
      <p>{props.text}</p>
      <p>
        <a href="/">Back to Pocket Pager</a>
      </p>
    </Layout>
  );
}
```

- [ ] **Step 6: Implement `server/src/web/authRoutes.tsx`**

```tsx
import { Hono } from "hono";
import type { AppDeps } from "../app";
import { AuthError } from "../auth/google";
import { constantTimeEqual, randomToken } from "../auth/tokens";
import { findOrCreateAccount, type Identity } from "../services/accounts";
import { createSession, revokeSession } from "../services/sessions";
import { renderHtml } from "./http";
import { MessagePage } from "./layout";
import { clearSessionCookie, currentWebSession, hasValidCsrf, setSessionCookie, setStateCookie, takeStateCookie } from "./session";

export function webAuthRoutes(deps: AppDeps): Hono {
  const routes = new Hono();

  routes.get("/auth/google", (c) => {
    const state = randomToken();
    setStateCookie(c, deps.config, state);
    return c.redirect(deps.googleOAuth.authorizationUrl(state), 302);
  });

  routes.get("/auth/google/callback", async (c) => {
    const expected = takeStateCookie(c, deps.config);
    if (c.req.query("error")) return c.redirect("/", 303);
    const state = c.req.query("state");
    const code = c.req.query("code");
    if (!expected || !state || !code || !constantTimeEqual(state, expected)) {
      return renderHtml(c, <MessagePage title="Sign-in expired" text="Your sign-in attempt expired. Please try again." />, 400);
    }
    let identity: Identity;
    try {
      identity = await deps.google.verify(await deps.googleOAuth.exchangeCode(code));
    } catch (err) {
      if (err instanceof AuthError) {
        return renderHtml(c, <MessagePage title="Sign-in failed" text="Google sign-in could not be verified. Please try again." />, 401);
      }
      throw err;
    }
    const account = findOrCreateAccount(deps, identity);
    const { token } = createSession(deps, account.id, "web");
    setSessionCookie(c, deps.config, token);
    return c.redirect("/", 303);
  });

  routes.post("/auth/logout", async (c) => {
    const web = currentWebSession(deps, c);
    if (web && (await hasValidCsrf(c, web))) {
      revokeSession(deps, web.session);
      clearSessionCookie(c, deps.config);
    }
    return c.redirect("/", 303);
  });

  return routes;
}
```

- [ ] **Step 7: Implement `server/src/web/dashboard.tsx`**

```tsx
import { Hono } from "hono";
import type { AppDeps } from "../app";
import { getAccount, triggerUrl } from "../services/accounts";
import { listDevices } from "../services/devices";
import { createPage, listPagesForAccount, type PageRow, TEST_PAGE_INPUT, viewUrl } from "../services/pages";
import { renderHtml } from "./http";
import { Layout, MessagePage } from "./layout";
import { currentWebSession, hasValidCsrf } from "./session";

function SignedOut() {
  return (
    <Layout title="Pocket Pager">
      <section class="hero">
        <h1>Pocket Pager</h1>
        <p>A personal pager for your iPhone and Mac. Get one private URL, call it from any script, and your devices sound.</p>
        <a class="button primary" href="/auth/google">
          Sign in with Google
        </a>
      </section>
    </Layout>
  );
}

function curlExamples(url: string): string {
  return [
    `curl -X POST ${url}`,
    `curl -d "Your deployment is ready" ${url}`,
    `curl ${url} \\\n  -H "Content-Type: application/json" \\\n  -d '{"title":"Build finished","message":"Ready for review","url":"https://example.com"}'`,
  ].join("\n\n");
}

function Dashboard(props: {
  email: string;
  url: string;
  deviceCount: number;
  pages: PageRow[];
  csrf: string;
  flash: string | null;
  viewUrlFor: (publicId: string) => string;
}) {
  return (
    <Layout title="Pocket Pager">
      <header class="top">
        <h1>Pocket Pager</h1>
        <form method="post" action="/auth/logout">
          <input type="hidden" name="_csrf" value={props.csrf} />
          <span class="muted">{props.email}</span> <button type="submit" class="link">Sign out</button>
        </form>
      </header>
      {props.flash && (
        <p class="flash" role="status">
          {props.flash}
        </p>
      )}
      <section>
        <h2>Your pager URL</h2>
        <p class="muted">Anyone with this URL can page you. Keep it private.</p>
        <div class="url-row">
          <code id="pager-url">{props.url}</code>
          <button type="button" data-copy="pager-url">
            Copy
          </button>
        </div>
        <pre>
          <code>{curlExamples(props.url)}</code>
        </pre>
        <form method="post" action="/test">
          <input type="hidden" name="_csrf" value={props.csrf} />
          <button type="submit" class="primary">
            Test my pager
          </button>
        </form>
        {props.deviceCount === 0 ? (
          <p class="warning">No devices yet. Install Pocket Pager on your iPhone or Mac and sign in with this Google account.</p>
        ) : (
          <p class="muted">{props.deviceCount === 1 ? "1 device" : `${props.deviceCount} devices`} will be paged.</p>
        )}
      </section>
      <section>
        <h2>Recent pages</h2>
        {props.pages.length === 0 ? (
          <p class="muted">Your pager is ready.</p>
        ) : (
          <ul class="pages">
            {props.pages.map((page) => {
              const created = new Date(page.created_at).toISOString();
              return (
                <li>
                  <a href={props.viewUrlFor(page.public_id)}>
                    <strong>{page.title ?? page.message}</strong>
                    {page.title && <span class="muted"> — {page.message}</span>}
                  </a>
                  <time datetime={created}>{created}</time>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </Layout>
  );
}

export function dashboardRoutes(deps: AppDeps): Hono {
  const routes = new Hono();

  routes.get("/", (c) => {
    const web = currentWebSession(deps, c);
    const account = web ? getAccount(deps, web.session.account_id) : null;
    if (!web || !account) return renderHtml(c, <SignedOut />);
    const pages = listPagesForAccount(deps, account.id, { beforeId: null, limit: 20 });
    const flash = c.req.query("sent")
      ? "Test page sent."
      : c.req.query("limited")
        ? "Too many pages right now. Try again in a minute."
        : null;
    return renderHtml(
      c,
      <Dashboard
        email={account.email}
        url={triggerUrl(deps, account.id)}
        deviceCount={listDevices(deps, account.id).length}
        pages={pages.ok ? pages.pages : []}
        csrf={web.csrf}
        flash={flash}
        viewUrlFor={(publicId) => viewUrl(deps.config, publicId)}
      />,
    );
  });

  routes.post("/test", async (c) => {
    const web = currentWebSession(deps, c);
    if (!web) return c.redirect("/", 303);
    if (!(await hasValidCsrf(c, web))) {
      return renderHtml(c, <MessagePage title="Form expired" text="This form expired. Go back and try again." />, 403);
    }
    const result = createPage(deps, { accountId: web.session.account_id, input: TEST_PAGE_INPUT, source: "test", idempotencyKey: null });
    if (!result.ok) return c.redirect("/?limited=1", 303);
    deps.worker.wake();
    return c.redirect("/?sent=1", 303);
  });

  return routes;
}
```

- [ ] **Step 8: Write the static assets**

`server/public/app.js`:

```js
// Copy buttons: <button data-copy="element-id">
document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy]");
  if (!button) return;
  const source = document.getElementById(button.dataset.copy);
  if (!source) return;
  await navigator.clipboard.writeText(source.textContent.trim());
  const label = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => {
    button.textContent = label;
  }, 1500);
});

// Show times in the reader's time zone.
document.addEventListener("DOMContentLoaded", () => {
  for (const el of document.querySelectorAll("time[datetime]")) {
    el.textContent = new Date(el.dateTime).toLocaleString();
  }
});
```

`server/public/style.css`:

```css
:root {
  color-scheme: light dark;
  --bg: #fafafa;
  --fg: #1d1d1f;
  --muted: #6e6e73;
  --card: #ffffff;
  --border: #d2d2d7;
  --accent: #d9480f;
  --warning: #9a6700;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111113;
    --fg: #f5f5f7;
    --muted: #a1a1a6;
    --card: #1c1c1e;
    --border: #3a3a3c;
    --accent: #ff8a4c;
    --warning: #e3b341;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { max-width: 720px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 1.6rem; margin: 0 0 8px; }
h2 { font-size: 1.1rem; margin: 32px 0 8px; }
section { overflow-wrap: anywhere; }
.muted { color: var(--muted); }
.warning { color: var(--warning); }
.flash { padding: 8px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--card); }
.top { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
.url-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
code { font: 0.9rem ui-monospace, SFMono-Regular, Menlo, monospace; }
#pager-url { padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--card); word-break: break-all; }
pre { padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--card); overflow-x: auto; }
button, .button { display: inline-block; font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--border); background: var(--card); color: var(--fg); cursor: pointer; text-decoration: none; }
.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.link { border: none; background: none; padding: 0; color: var(--accent); }
.pages { list-style: none; padding: 0; margin: 0; }
.pages li { display: flex; justify-content: space-between; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border); }
.pages a { color: inherit; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pages time { color: var(--muted); white-space: nowrap; font-size: 0.85rem; }
.hero { padding-top: 15vh; }
.page .message { white-space: pre-wrap; }
.details { border-top: 1px solid var(--border); margin-top: 16px; padding-top: 8px; }
.details img { max-width: 100%; }
```

- [ ] **Step 9: Wire the web routes into `server/src/app.ts`**

Add these imports:

```ts
import { serveStatic } from "hono/bun";
import { dashboardRoutes } from "./web/dashboard";
import { webAuthRoutes } from "./web/authRoutes";
import { securityHeaders } from "./web/http";
```

Directly after `app.use("*", requestLogger(deps.logger));`, add:

```ts
  app.use("*", securityHeaders());
  app.use("/static/*", serveStatic({ root: "./public", rewriteRequestPath: (path) => path.replace(/^\/static/, "") }));
```

After `app.route("/api", appApiRoutes(deps));`, add:

```ts
  app.route("/", webAuthRoutes(deps));
  app.route("/", dashboardRoutes(deps));
```

- [ ] **Step 10: Run all tests**

Run: `cd server && bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add server
git commit -m "feat(web): Google sign-in, CSRF-protected dashboard with pager URL, test button and recent pages"
```

---

### Task 16: Public page view

**Files:**
- Create: `server/src/web/markdown.ts`, `server/src/web/publicView.tsx`
- Modify: `server/src/services/pages.ts` (add `findPublicPage`), `server/src/app.ts` (mount the routes)
- Test: `server/test/web/markdown.test.ts`, `server/test/web/publicView.test.ts`

**Interfaces:**
- Consumes: `Layout`, `MessagePage`, `renderHtml`, `getPageByPublicId`, `isTokenShaped`, `PAGE_RETENTION_MS`.
- Produces:
  - `renderMarkdown(source: string): string`.
  - `findPublicPage(ctx, publicId): PageRow | null`.
  - `publicViewRoutes(deps): Hono`.

- [ ] **Step 1: Write the failing Markdown tests** (`server/test/web/markdown.test.ts`)

```ts
import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../../src/web/markdown";

describe("renderMarkdown", () => {
  test("renders ordinary Markdown", () => {
    const html = renderMarkdown("**bold** and `code`\n\n- item");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<li>item</li>");
  });

  test("escapes raw HTML instead of rendering it", () => {
    for (const attack of ["<script>alert(1)</script>", '<img src=x onerror="alert(1)">', "<iframe src=//evil></iframe>", "<a href=javascript:alert(1)>x</a>"]) {
      const html = renderMarkdown(attack);
      expect(html).not.toMatch(/<(script|img|iframe|a)\b/i);
      expect(html).toContain("&lt;");
    }
  });

  test("refuses dangerous link schemes", () => {
    for (const href of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "vbscript:msgbox(1)", "file:///etc/passwd", "data:text/html,<script>alert(1)</script>"]) {
      expect(renderMarkdown(`[click](${href})`)).not.toContain("href=");
    }
  });

  test("safe links are kept and marked noopener noreferrer nofollow", () => {
    expect(renderMarkdown("[docs](https://example.com)")).toContain('<a href="https://example.com" rel="noopener noreferrer nofollow">docs</a>');
  });
});
```

- [ ] **Step 2: Write the failing view tests** (`server/test/web/publicView.test.ts`)

```ts
import { describe, expect, test } from "bun:test";
import { createPage } from "../../src/services/pages";
import type { PageInput } from "../../src/services/pageInput";
import { seedAccount, testApp } from "../helpers";

function makePage(t: ReturnType<typeof testApp>, input: Partial<PageInput> = {}) {
  const { account, triggerToken } = seedAccount(t.ctx);
  const r = createPage(t.ctx, {
    accountId: account.id,
    input: { title: null, message: "hello", details: null, url: null, group: null, ...input },
    source: "trigger",
    idempotencyKey: null,
  });
  if (!r.ok) throw new Error("rate limited");
  return { page: r.page, triggerToken, account };
}

describe("GET /v/:publicId", () => {
  test("renders title, message, Markdown details and the link without sign-in", async () => {
    const t = testApp();
    const { page } = makePage(t, { title: "Build finished", message: "Ready", details: "**All green**", url: "https://ci.example/1" });
    const res = await t.app.request(`/v/${page.public_id}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h1>Build finished</h1>");
    expect(html).toContain("Ready");
    expect(html).toContain("<strong>All green</strong>");
    expect(html).toContain('href="https://ci.example/1"');
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  test("escapes hostile titles and messages", async () => {
    const t = testApp();
    const { page } = makePage(t, { title: '<img src=x onerror="alert(1)">', message: "<script>alert(2)</script>" });
    const html = await (await t.app.request(`/v/${page.public_id}`)).text();
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert(2)");
  });

  test("an attribute-breaking URL cannot inject attributes", async () => {
    const t = testApp();
    const { page } = makePage(t, { url: 'https://e.com/"onmouseover="alert(1)' });
    const html = await (await t.app.request(`/v/${page.public_id}`)).text();
    expect(html).not.toContain('"onmouseover="');
  });

  test("never exposes the account's trigger URL", async () => {
    const t = testApp();
    const { page, triggerToken } = makePage(t);
    expect(await (await t.app.request(`/v/${page.public_id}`)).text()).not.toContain(triggerToken);
  });

  test("unknown, malformed, expired and deleted pages are a noindex 404", async () => {
    const t = testApp();
    const { page } = makePage(t);
    for (const id of ["x".repeat(43), "short", "../../etc"]) {
      const res = await t.app.request(`/v/${id}`);
      expect(res.status).toBe(404);
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }
    t.ctx.clock.advance(30 * 24 * 60 * 60 * 1000 + 1);
    expect((await t.app.request(`/v/${page.public_id}`)).status).toBe(404);

    const fresh = testApp();
    const second = makePage(fresh);
    fresh.ctx.db.query("DELETE FROM accounts WHERE id = $id").run({ id: second.account.id });
    expect((await fresh.app.request(`/v/${second.page.public_id}`)).status).toBe(404);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd server && bun test test/web`
Expected: FAIL with "Cannot find module '../../src/web/markdown'".

- [ ] **Step 4: Implement `server/src/web/markdown.ts`**

```ts
import MarkdownIt from "markdown-it";

// html: false escapes raw HTML; markdown-it's validateLink refuses javascript:, vbscript:, file: and data: (except images).
const md = new MarkdownIt({ html: false, linkify: false, breaks: true });

const renderLinkOpen =
  md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx]!.attrSet("rel", "noopener noreferrer nofollow");
  return renderLinkOpen(tokens, idx, options, env, self);
};

export function renderMarkdown(source: string): string {
  return md.render(source);
}
```

- [ ] **Step 5: Add `findPublicPage` to `server/src/services/pages.ts`**

Add `getPageByPublicId` to the `db/pages` import and `isTokenShaped` to the `auth/tokens` import. Then append:

```ts
export function findPublicPage(ctx: Ctx, publicId: string): PageRow | null {
  if (!isTokenShaped(publicId)) return null;
  const page = getPageByPublicId(ctx.db, publicId);
  if (!page || page.created_at <= ctx.now() - PAGE_RETENTION_MS) return null;
  return page;
}
```

- [ ] **Step 6: Implement `server/src/web/publicView.tsx`**

```tsx
import { Hono } from "hono";
import { raw } from "hono/html";
import type { AppDeps } from "../app";
import { findPublicPage, type PageRow } from "../services/pages";
import { renderHtml } from "./http";
import { Layout, MessagePage } from "./layout";
import { renderMarkdown } from "./markdown";

function PageView({ page }: { page: PageRow }) {
  const created = new Date(page.created_at).toISOString();
  return (
    <Layout title={page.title ?? "Pocket Pager"}>
      <article class="page">
        <p class="muted">
          <time datetime={created}>{created}</time>
        </p>
        <h1>{page.title ?? page.message}</h1>
        {page.title && <p class="message">{page.message}</p>}
        {page.details && <div class="details">{raw(renderMarkdown(page.details))}</div>}
        {page.url && (
          <p>
            <a class="button primary" href={page.url} rel="noopener noreferrer nofollow">
              Open link
            </a>
          </p>
        )}
      </article>
    </Layout>
  );
}

export function publicViewRoutes(deps: AppDeps): Hono {
  const routes = new Hono();
  routes.get("/v/:publicId", (c) => {
    c.header("X-Robots-Tag", "noindex, nofollow");
    c.header("Cache-Control", "private, no-store");
    const page = findPublicPage(deps, c.req.param("publicId"));
    if (!page) return renderHtml(c, <MessagePage title="Page not found" text="This page doesn't exist or has expired." />, 404);
    return renderHtml(c, <PageView page={page} />);
  });
  return routes;
}
```

- [ ] **Step 7: Mount it in `server/src/app.ts`**

Add the import `import { publicViewRoutes } from "./web/publicView";`. After `app.route("/", dashboardRoutes(deps));`, add:

```ts
  app.route("/", publicViewRoutes(deps));
```

- [ ] **Step 8: Run all tests**

Run: `cd server && bun test && bun run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server
git commit -m "feat(web): public page view with safe Markdown details"
```

---

### Task 17: Container and deployment with siteio

**Files:**
- Create: `server/Dockerfile`, `server/.dockerignore`
- Modify: `.gitignore` (add `server/secrets.env`)

The user takes part in this task: GitHub, Google Cloud and DNS need their accounts.

- [ ] **Step 1: Write the container files**

`server/Dockerfile`:

```dockerfile
FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY public ./public
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/data/pagerio.db
EXPOSE 3000
CMD ["bun", "src/index.ts"]
```

`server/.dockerignore`:

```
node_modules
.env
secrets.env
data
test
```

`server/secrets.env` is already ignored (Task 1).

- [ ] **Step 2: Build and smoke-test the image locally** (skip this step if Docker is not installed)

```bash
cd server
docker build -t pagerio .
docker run --rm -d --name pagerio-smoke -p 3000:3000 --env-file .env \
  -e PUBLIC_BASE_URL=http://localhost:3000 -e TOKEN_ENC_KEY=$(openssl rand -base64 32) \
  -e GOOGLE_CLIENT_ID_WEB=x -e GOOGLE_CLIENT_SECRET_WEB=x -e GOOGLE_CLIENT_ID_IOS=x -e GOOGLE_CLIENT_ID_MACOS=x \
  -v pagerio-smoke:/data pagerio
curl -s localhost:3000/healthz
docker rm -f pagerio-smoke && docker volume rm pagerio-smoke
```

Expected: `{"ok":true,"oldest_pending_ms":0}`.

- [ ] **Step 3: Commit**

```bash
git add .gitignore server/Dockerfile server/.dockerignore
git commit -m "build(server): container image for siteio"
```

- [ ] **Step 4: Google Cloud setup** (already done on 2026-10-02; the client IDs are in Step 6 and Task 20. Kept for reference.)
  1. In the Google Cloud console, configure the **OAuth consent screen** (External, scope `openid email`) and add the testers' Google accounts.
  2. Create an **OAuth client, type Web application**:
     - Authorized redirect URIs: `https://pagerio.chuut.com/auth/google/callback` and `http://localhost:3000/auth/google/callback`.
     - Note the client ID and secret.
  3. Create an **OAuth client, type iOS**, with bundle ID `com.chuut.pagerio`. Note the client ID.
  4. Create another **OAuth client, type iOS** (Google uses this type for macOS), with bundle ID `com.chuut.pagerio.mac`. Note the client ID.

- [ ] **Step 5: Push the repository**

`origin` is already the public repository `git@github.com:plosson/pagerio.git`. Before pushing, check that no secret is tracked:

```bash
git ls-files | grep -E '\.env$|secrets\.env|\.p8$' && echo "STOP: secret tracked" || git push origin main
```

- [ ] **Step 6: Complete the production secrets file** (git-ignored, mode 600)

`server/secrets.env` was created on 2026-10-02 with a generated `TOKEN_ENC_KEY`, the team ID and the three Google client IDs. Fill in what is still empty, without printing the values:
- `APNS_KEY_P8`: the output of `base64 -i ~/.config/pagerio/AuthKey_<KEYID>.p8`.
- `APNS_KEY_ID`: the Key ID from Task 4.
- `GOOGLE_CLIENT_SECRET_WEB`: the user types it in.

Check that nothing is empty, showing names only:

```bash
grep -E '^[A-Z_]+=$' server/secrets.env | cut -d= -f1   # expect no output
```

- [ ] **Step 7: Deploy**

```bash
siteio apps create pagerio --git https://github.com/plosson/pagerio --context server --port 3000
siteio apps set pagerio -v pagerio-data:/data -d pagerio.chuut.com -r unless-stopped -e PUBLIC_BASE_URL=https://pagerio.chuut.com
siteio apps set pagerio --secret ./server/secrets.env
siteio apps deploy pagerio
```

No DNS work is needed: siteio serves `*.chuut.com` and issues the certificate.

- [ ] **Step 8: Verify production**

```bash
curl -s https://pagerio.chuut.com/healthz
open https://pagerio.chuut.com   # sign in with Google, copy the URL
curl -X POST <your pager URL>     # expect 202 {"id":…,"status":"accepted","view_url":…}
```

Expected:
- `healthz` returns `{"ok":true,…}`.
- Google sign-in lands on the dashboard showing your URL and "No devices yet".
- The curl prints a `202`, and its `view_url` opens the public page.

---

# Phase 2 — Complete the loop (Apple)

### Task 18: PagerKit networking and session

**Files:**
- Create: `apple/PagerKit/Sources/PagerKit/Models.swift`, `APIClient.swift`, `SecretStore.swift`, `SessionController.swift`
- Test: `apple/PagerKit/Tests/PagerKitTests/TestSupport.swift`, `APIClientTests.swift`, `SessionControllerTests.swift`

**Interfaces:**
- Consumes: the JSON contract from Task 14.
- Produces:
  - **Models:**
    - `PageSummary` (`id`, `title?`, `message`, `url?`, `viewURL`, `source`, `createdAt`, `headline`).
    - `PagesResponse { pages, nextBefore }`.
    - `AuthResponse { sessionToken, email }`.
    - `DeviceRegistration { apnsToken, platform, model, apnsEnv }`.
    - `APIError { status, code, message }`.
  - **APIClient:**
    - `init(baseURL:session:tokenProvider:onUnauthorized:)`.
    - `exchangeGoogleToken(_:) async throws -> AuthResponse`.
    - `logout()` and `registerDevice(_:)`.
    - `pages(before:limit:) -> PagesResponse`.
    - `sendTest()`.
  - **Secret storage:** `protocol SecretStore { read(_:) -> String?; write(_:_:) }`, implemented by `KeychainStore(service:)` and `InMemorySecretStore`.
  - **SessionController** (`@MainActor @Observable`):
    - `tokenKey` and `emailKey`.
    - `isSignedIn` and `email`.
    - `completeSignIn(idToken:api:)`, `signOut(api:)` and `clear()`.

- [ ] **Step 1: Write the test support** (`apple/PagerKit/Tests/PagerKitTests/TestSupport.swift`)

```swift
import Foundation
import Testing

/// Every suite that uses StubURLProtocol nests under this serialized suite, because the stub is global.
@Suite(.serialized) enum Network {}

final class StubURLProtocol: URLProtocol {
    struct Reply: Sendable {
        var status: Int // negative: fail with a network error
        var body: Data
    }

    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) -> Reply)?
    nonisolated(unsafe) static var requests: [URLRequest] = []

    static func reset(_ handler: @escaping @Sendable (URLRequest) -> Reply) {
        self.handler = handler
        requests = []
    }

    static func json(_ status: Int, _ text: String) -> Reply { Reply(status: status, body: Data(text.utf8)) }
    static let offline = Reply(status: -1, body: Data())

    static func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var captured = request
        if captured.httpBody == nil, let stream = captured.httpBodyStream { captured.httpBody = Self.read(stream) }
        Self.requests.append(captured)
        let reply = Self.handler?(captured) ?? Reply(status: 500, body: Data())
        if reply.status < 0 {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        let response = HTTPURLResponse(url: captured.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: reply.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func read(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func hit() { lock.withLock { count += 1 } }
    var value: Int { lock.withLock { count } }
}

func jsonBody(_ request: URLRequest) throws -> [String: String] {
    let data = try #require(request.httpBody)
    return try #require(JSONSerialization.jsonObject(with: data) as? [String: String])
}

let testBaseURL = URL(string: "https://pager.test")!
```

- [ ] **Step 2: Write the failing API client tests** (`apple/PagerKit/Tests/PagerKitTests/APIClientTests.swift`)

```swift
import Foundation
import Testing
@testable import PagerKit

extension Network {
    @Suite struct APIClientTests {
        func client(token: String? = "tok", onUnauthorized: @escaping @Sendable () -> Void = {}) -> APIClient {
            APIClient(baseURL: testBaseURL, session: StubURLProtocol.session(), tokenProvider: { token }, onUnauthorized: onUnauthorized)
        }

        @Test func signInPostsTheIdTokenWithoutAuthorization() async throws {
            StubURLProtocol.reset { _ in StubURLProtocol.json(200, #"{"session_token":"s1","email":"a@example.com"}"#) }
            let auth = try await client(token: nil).exchangeGoogleToken("google-id")
            #expect(auth == AuthResponse(sessionToken: "s1", email: "a@example.com"))
            let request = try #require(StubURLProtocol.requests.first)
            #expect(request.httpMethod == "POST")
            #expect(request.url?.path == "/api/auth/google")
            #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
            #expect(try jsonBody(request) == ["id_token": "google-id"])
        }

        @Test func pagesSendsBearerAndCursorAndDecodesServerDates() async throws {
            StubURLProtocol.reset { _ in
                StubURLProtocol.json(200, #"""
                {"pages":[{"id":"pg_1","title":null,"message":"hi","url":"https://e.com/1","view_url":"https://pager.test/v/abc","source":"trigger","created_at":"2026-10-02T12:00:00.123Z"}],"next_before":"pg_1"}
                """#)
            }
            let response = try await client().pages(before: "pg_0", limit: 10)
            let request = try #require(StubURLProtocol.requests.first)
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer tok")
            let items = Set(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? [])
            #expect(items == [URLQueryItem(name: "limit", value: "10"), URLQueryItem(name: "before", value: "pg_0")])
            let page = try #require(response.pages.first)
            #expect(page.headline == "hi")
            #expect(page.viewURL == URL(string: "https://pager.test/v/abc"))
            #expect(abs(page.createdAt.timeIntervalSince1970 - 1_790_942_400.123) < 0.001)
            #expect(response.nextBefore == "pg_1")
        }

        @Test func aMalformedLinkDoesNotBreakTheWholeList() async throws {
            StubURLProtocol.reset { _ in
                StubURLProtocol.json(200, #"{"pages":[{"id":"pg_1","title":"T","message":"m","url":"http://[bad","view_url":"https://pager.test/v/x","source":"test","created_at":"2026-10-02T12:00:00Z"}],"next_before":null}"#)
            }
            let response = try await client().pages()
            #expect(response.pages.first?.url == nil)
            #expect(response.pages.first?.headline == "T")
        }

        @Test func unauthorizedSignsOutOnceAndSurfacesTheServerMessage() async throws {
            let counter = Counter()
            StubURLProtocol.reset { _ in StubURLProtocol.json(401, #"{"error":{"code":"unauthorized","message":"Sign in again."}}"#) }
            let error = await #expect(throws: APIError.self) { try await client(onUnauthorized: { counter.hit() }).pages() }
            #expect(error == APIError(status: 401, code: "unauthorized", message: "Sign in again."))
            #expect(counter.value == 1)
        }

        @Test func aRejectedGoogleSignInDoesNotTriggerSignOut() async throws {
            let counter = Counter()
            StubURLProtocol.reset { _ in StubURLProtocol.json(401, #"{"error":{"code":"unauthorized","message":"nope"}}"#) }
            await #expect(throws: APIError.self) { try await client(token: nil, onUnauthorized: { counter.hit() }).exchangeGoogleToken("x") }
            #expect(counter.value == 0)
        }

        @Test func nonJSONErrorsBecomeReadableErrors() async throws {
            StubURLProtocol.reset { _ in StubURLProtocol.json(502, "<html>Bad Gateway</html>") }
            let error = await #expect(throws: APIError.self) { try await client().sendTest() }
            #expect(error?.status == 502)
            #expect(error?.code == "http_502")
        }

        @Test func callsWithoutASessionFailWithoutTouchingTheNetwork() async throws {
            let counter = Counter()
            StubURLProtocol.reset { _ in StubURLProtocol.json(200, "{}") }
            await #expect(throws: APIError.self) { try await client(token: nil, onUnauthorized: { counter.hit() }).pages() }
            #expect(StubURLProtocol.requests.isEmpty)
            #expect(counter.value == 0)
        }

        @Test func garbageOnSuccessIsADecodingError() async throws {
            StubURLProtocol.reset { _ in StubURLProtocol.json(200, "{") }
            await #expect(throws: DecodingError.self) { try await client().pages() }
        }

        @Test func registerDeviceSendsTheSnakeCaseContract() async throws {
            StubURLProtocol.reset { _ in StubURLProtocol.json(200, #"{"id":"dev_1"}"#) }
            try await client().registerDevice(DeviceRegistration(apnsToken: "ab", platform: "ios", model: "iPhone17,1", apnsEnv: "sandbox"))
            let request = try #require(StubURLProtocol.requests.first)
            #expect(request.httpMethod == "PUT")
            #expect(request.url?.path == "/api/devices/current")
            #expect(try jsonBody(request) == ["apns_token": "ab", "platform": "ios", "model": "iPhone17,1", "apns_env": "sandbox"])
        }

        @Test func logoutAccepts204WithAnEmptyBody() async throws {
            StubURLProtocol.reset { _ in StubURLProtocol.json(204, "") }
            try await client().logout()
            #expect(StubURLProtocol.requests.first?.httpMethod == "POST")
        }
    }
}
```

- [ ] **Step 3: Write the failing session tests** (`apple/PagerKit/Tests/PagerKitTests/SessionControllerTests.swift`)

```swift
import Foundation
import Testing
@testable import PagerKit

extension Network {
    @Suite @MainActor struct SessionControllerTests {
        let api = APIClient(baseURL: testBaseURL, session: StubURLProtocol.session(), tokenProvider: { "tok" })

        @Test func startsSignedInWhenATokenIsStored() {
            let session = SessionController(store: InMemorySecretStore(["session_token": "s", "email": "a@example.com"]))
            #expect(session.isSignedIn)
            #expect(session.email == "a@example.com")
        }

        @Test func completeSignInStoresTheSession() async throws {
            StubURLProtocol.reset { _ in StubURLProtocol.json(200, #"{"session_token":"s1","email":"a@example.com"}"#) }
            let store = InMemorySecretStore()
            let session = SessionController(store: store)
            try await session.completeSignIn(idToken: "g", api: api)
            #expect(session.isSignedIn)
            #expect(store.read(SessionController.tokenKey) == "s1")
            #expect(session.email == "a@example.com")
        }

        @Test func aFailedSignInLeavesYouSignedOut() async {
            StubURLProtocol.reset { _ in StubURLProtocol.json(401, #"{"error":{"code":"unauthorized","message":"no"}}"#) }
            let store = InMemorySecretStore()
            let session = SessionController(store: store)
            await #expect(throws: APIError.self) { try await session.completeSignIn(idToken: "g", api: api) }
            #expect(!session.isSignedIn)
            #expect(store.read(SessionController.tokenKey) == nil)
        }

        @Test func signOutClearsLocallyEvenWhenTheServerIsDown() async {
            StubURLProtocol.reset { _ in StubURLProtocol.offline }
            let store = InMemorySecretStore(["session_token": "s", "email": "e"])
            let session = SessionController(store: store)
            await session.signOut(api: api)
            #expect(!session.isSignedIn)
            #expect(session.email == nil)
            #expect(store.read(SessionController.tokenKey) == nil)
        }
    }
}
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd apple/PagerKit && swift test`
Expected: FAIL to compile with "cannot find 'APIClient' in scope".

- [ ] **Step 5: Implement `Models.swift`**

```swift
import Foundation

public struct PageSummary: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String?
    public let message: String
    public let url: URL?
    public let viewURL: URL
    public let source: String
    public let createdAt: Date

    public var headline: String { title ?? message }

    enum CodingKeys: String, CodingKey {
        case id, title, message, url, source
        case viewURL = "view_url"
        case createdAt = "created_at"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        title = try container.decodeIfPresent(String.self, forKey: .title)
        message = try container.decode(String.self, forKey: .message)
        // A sender-supplied link must never make the whole list undecodable.
        url = try container.decodeIfPresent(String.self, forKey: .url).flatMap(URL.init(string:))
        viewURL = try container.decode(URL.self, forKey: .viewURL)
        source = try container.decode(String.self, forKey: .source)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
    }
}

public struct PagesResponse: Decodable, Sendable {
    public let pages: [PageSummary]
    public let nextBefore: String?

    enum CodingKeys: String, CodingKey {
        case pages
        case nextBefore = "next_before"
    }
}

public struct AuthResponse: Decodable, Equatable, Sendable {
    public let sessionToken: String
    public let email: String

    enum CodingKeys: String, CodingKey {
        case sessionToken = "session_token"
        case email
    }
}

public struct DeviceRegistration: Encodable, Equatable, Sendable {
    public let apnsToken: String
    public let platform: String
    public let model: String
    public let apnsEnv: String

    enum CodingKeys: String, CodingKey {
        case apnsToken = "apns_token"
        case platform, model
        case apnsEnv = "apns_env"
    }
}

public struct APIError: Error, Equatable, Sendable {
    public let status: Int
    public let code: String
    public let message: String
}

struct ErrorEnvelope: Decodable {
    struct Detail: Decodable {
        let code: String
        let message: String
    }

    let error: Detail
}

func makeDecoder() -> JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
        let container = try decoder.singleValueContainer()
        let text = try container.decode(String.self)
        if let date = try? Date(text, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) { return date }
        if let date = try? Date(text, strategy: .iso8601) { return date }
        throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid date")
    }
    return decoder
}
```

- [ ] **Step 6: Implement `APIClient.swift`**

```swift
import Foundation

public final class APIClient: Sendable {
    public let baseURL: URL
    private let session: URLSession
    private let tokenProvider: @Sendable () -> String?
    private let onUnauthorized: @Sendable () -> Void

    public init(
        baseURL: URL,
        session: URLSession = .shared,
        tokenProvider: @escaping @Sendable () -> String?,
        onUnauthorized: @escaping @Sendable () -> Void = {}
    ) {
        self.baseURL = baseURL
        self.session = session
        self.tokenProvider = tokenProvider
        self.onUnauthorized = onUnauthorized
    }

    public func exchangeGoogleToken(_ idToken: String) async throws -> AuthResponse {
        let data = try await send("POST", "api/auth/google", body: try JSONEncoder().encode(["id_token": idToken]), authenticated: false)
        return try makeDecoder().decode(AuthResponse.self, from: data)
    }

    public func logout() async throws {
        _ = try await send("POST", "api/auth/logout")
    }

    public func registerDevice(_ registration: DeviceRegistration) async throws {
        _ = try await send("PUT", "api/devices/current", body: try JSONEncoder().encode(registration))
    }

    public func pages(before: String? = nil, limit: Int = 50) async throws -> PagesResponse {
        var query = [URLQueryItem(name: "limit", value: String(limit))]
        if let before { query.append(URLQueryItem(name: "before", value: before)) }
        let data = try await send("GET", "api/pages", query: query)
        return try makeDecoder().decode(PagesResponse.self, from: data)
    }

    public func sendTest() async throws {
        _ = try await send("POST", "api/test")
    }

    private func send(
        _ method: String,
        _ path: String,
        query: [URLQueryItem] = [],
        body: Data? = nil,
        authenticated: Bool = true
    ) async throws -> Data {
        var components = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query }
        var request = URLRequest(url: components.url!)
        request.httpMethod = method
        request.timeoutInterval = 20
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if authenticated {
            guard let token = tokenProvider() else {
                throw APIError(status: 401, code: "unauthorized", message: "You're signed out.")
            }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            if status == 401 && authenticated { onUnauthorized() }
            let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: data)
            throw APIError(
                status: status,
                code: envelope?.error.code ?? "http_\(status)",
                message: envelope?.error.message ?? "The server returned an error (\(status))."
            )
        }
        return data
    }
}
```

- [ ] **Step 7: Implement `SecretStore.swift`**

```swift
import Foundation
import Security

public protocol SecretStore: Sendable {
    func read(_ key: String) -> String?
    func write(_ key: String, _ value: String?)
}

/// Generic-password items in the data-protection keychain, readable after first unlock
/// so a background launch (notification arrives while locked) can still authenticate.
public final class KeychainStore: SecretStore {
    private let service: String

    public init(service: String) {
        self.service = service
    }

    public func read(_ key: String) -> String? {
        var query = baseQuery(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func write(_ key: String, _ value: String?) {
        SecItemDelete(baseQuery(key) as CFDictionary)
        guard let value else { return }
        var query = baseQuery(key)
        query[kSecValueData as String] = Data(value.utf8)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(query as CFDictionary, nil)
    }

    private func baseQuery(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecUseDataProtectionKeychain as String: true,
        ]
    }
}

public final class InMemorySecretStore: SecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String]

    public init(_ values: [String: String] = [:]) {
        self.values = values
    }

    public func read(_ key: String) -> String? {
        lock.withLock { values[key] }
    }

    public func write(_ key: String, _ value: String?) {
        lock.withLock { values[key] = value }
    }
}
```

- [ ] **Step 8: Implement `SessionController.swift`**

```swift
import Observation

@MainActor @Observable
public final class SessionController {
    public nonisolated static let tokenKey = "session_token"
    public nonisolated static let emailKey = "email"

    public private(set) var isSignedIn: Bool
    public private(set) var email: String?
    private let store: any SecretStore

    public init(store: any SecretStore) {
        self.store = store
        isSignedIn = store.read(Self.tokenKey) != nil
        email = store.read(Self.emailKey)
    }

    public func completeSignIn(idToken: String, api: APIClient) async throws {
        let auth = try await api.exchangeGoogleToken(idToken)
        store.write(Self.tokenKey, auth.sessionToken)
        store.write(Self.emailKey, auth.email)
        email = auth.email
        isSignedIn = true
    }

    /// Best effort on the server; always signs out locally.
    public func signOut(api: APIClient) async {
        try? await api.logout()
        clear()
    }

    public func clear() {
        store.write(Self.tokenKey, nil)
        store.write(Self.emailKey, nil)
        email = nil
        isSignedIn = false
    }
}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `cd apple/PagerKit && swift test`
Expected: PASS (all `DeviceTokenTests`, `APIClientTests` and `SessionControllerTests`).

- [ ] **Step 10: Commit**

```bash
git add apple/PagerKit
git commit -m "feat(pagerkit): API client, keychain session storage and session controller"
```

---

### Task 19: PagerKit device registration, pages, notifications and app services

**Files:**
- Create: `apple/PagerKit/Sources/PagerKit/DeviceRegistrar.swift`, `PagesStore.swift`, `NotificationPermission.swift`, `NotificationRoute.swift`, `AppServices.swift`
- Test: `apple/PagerKit/Tests/PagerKitTests/DeviceRegistrarTests.swift`, `PagesStoreTests.swift`, `NotificationRouteTests.swift`, `AppServicesTests.swift`

**Interfaces:**
- Consumes: `APIClient`, `SessionController`, `SecretStore`, `DeviceToken`, `DeviceModel`, `DevicePlatform`, `ApnsEnvironment`.
- Produces:
  - **DeviceRegistrar** (`@MainActor`):
    - `init(api:environment:isSignedIn:)`.
    - `latestToken` and `lastError`.
    - `didReceive(token:) async` and `registerIfPossible() async`.
  - **PagesStore** (`@MainActor @Observable`):
    - `pages`, `lastError` and `isLoading`.
    - `refresh()`, `sendTest()` and `reset()`.
  - **NotificationPermission** (`@MainActor @Observable`):
    - `Status { unknown, ready, off }` and `status`.
    - `refresh()` and `request()`.
    - `static func status(for:)`.
  - **NotificationRoute:**
    - `openLinkAction = "OPEN_LINK"` and `pageWithLinkCategory = "PAGE_WITH_LINK"`.
    - `url(for:actionIdentifier:) -> URL?`.
    - `categories() -> Set<UNNotificationCategory>`.
  - **AppServices** (`@MainActor @Observable`):
    - Properties: `api`, `session`, `pages`, `permission`, `registrar`, `dashboardURL`.
    - `init(baseURL:environment:store:urlSession:)`.
    - `signIn(idToken:)`, `signOut()` and `refreshAll()`.
    - `static func baseURL(bundle:)`.

- [ ] **Step 1: Write the failing tests**

`apple/PagerKit/Tests/PagerKitTests/DeviceRegistrarTests.swift`:

```swift
import Foundation
import Testing
@testable import PagerKit

extension Network {
    @Suite @MainActor struct DeviceRegistrarTests {
        let api = APIClient(baseURL: testBaseURL, session: StubURLProtocol.session(), tokenProvider: { "tok" })

        @Test func doesNothingWhileSignedOut() async {
            StubURLProtocol.reset { _ in StubURLProtocol.json(200, #"{"id":"d"}"#) }
            let registrar = DeviceRegistrar(api: api, environment: .sandbox, isSignedIn: { false })
            await registrar.didReceive(token: Data([0xab, 0xcd]))
            #expect(StubURLProtocol.requests.isEmpty)
            #expect(registrar.latestToken == Data([0xab, 0xcd]))
        }

        @Test func registersTheHexTokenPlatformModelAndEnvironment() async throws {
            StubURLProtocol.reset { _ in StubURLProtocol.json(200, #"{"id":"d"}"#) }
            let registrar = DeviceRegistrar(api: api, environment: .production, isSignedIn: { true })
            await registrar.didReceive(token: Data([0x00, 0xff]))
            let body = try jsonBody(try #require(StubURLProtocol.requests.first))
            #expect(body["apns_token"] == "00ff")
            #expect(body["platform"] == "macos")
            #expect(body["apns_env"] == "production")
            #expect(body["model"]?.isEmpty == false)
        }

        @Test func aChangedTokenIsRegisteredAgain() async throws {
            StubURLProtocol.reset { _ in StubURLProtocol.json(200, #"{"id":"d"}"#) }
            let registrar = DeviceRegistrar(api: api, environment: .sandbox, isSignedIn: { true })
            await registrar.didReceive(token: Data([0x01]))
            await registrar.didReceive(token: Data([0x02]))
            #expect(try StubURLProtocol.requests.map { try jsonBody($0)["apns_token"] } == ["01", "02"])
        }

        @Test func aFailureIsRecordedAndARetrySucceeds() async {
            StubURLProtocol.reset { _ in StubURLProtocol.offline }
            let registrar = DeviceRegistrar(api: api, environment: .sandbox, isSignedIn: { true })
            await registrar.didReceive(token: Data([0x01]))
            #expect(registrar.lastError != nil)
            StubURLProtocol.reset { _ in StubURLProtocol.json(200, #"{"id":"d"}"#) }
            await registrar.registerIfPossible()
            #expect(registrar.lastError == nil)
        }
    }
}
```

`apple/PagerKit/Tests/PagerKitTests/PagesStoreTests.swift`:

```swift
import Foundation
import Testing
@testable import PagerKit

private let onePage = #"{"pages":[{"id":"pg_1","title":null,"message":"hi","url":null,"view_url":"https://pager.test/v/a","source":"test","created_at":"2026-10-02T12:00:00.000Z"}],"next_before":null}"#

extension Network {
    @Suite @MainActor struct PagesStoreTests {
        let api = APIClient(baseURL: testBaseURL, session: StubURLProtocol.session(), tokenProvider: { "tok" })

        @Test func refreshLoadsPages() async {
            StubURLProtocol.reset { _ in StubURLProtocol.json(200, onePage) }
            let store = PagesStore(api: api)
            await store.refresh()
            #expect(store.pages.map(\.id) == ["pg_1"])
            #expect(store.lastError == nil)
            #expect(!store.isLoading)
        }

        @Test func aServerErrorKeepsOldPagesAndShowsTheMessage() async {
            StubURLProtocol.reset { _ in StubURLProtocol.json(200, onePage) }
            let store = PagesStore(api: api)
            await store.refresh()
            StubURLProtocol.reset { _ in StubURLProtocol.json(500, #"{"error":{"code":"internal","message":"Something went wrong. Try again."}}"#) }
            await store.refresh()
            #expect(store.pages.count == 1)
            #expect(store.lastError == "Something went wrong. Try again.")
        }

        @Test func beingOfflineGivesAFriendlyMessage() async {
            StubURLProtocol.reset { _ in StubURLProtocol.offline }
            let store = PagesStore(api: api)
            await store.refresh()
            #expect(store.lastError == "Couldn't reach Pocket Pager. Check your connection.")
        }

        @Test func sendTestPostsThenRefreshes() async {
            StubURLProtocol.reset { request in
                request.url?.path == "/api/test"
                    ? StubURLProtocol.json(202, #"{"id":"pg_1","status":"accepted","view_url":"https://pager.test/v/a"}"#)
                    : StubURLProtocol.json(200, onePage)
            }
            let store = PagesStore(api: api)
            await store.sendTest()
            #expect(StubURLProtocol.requests.map { "\($0.httpMethod!) \($0.url!.path)" } == ["POST /api/test", "GET /api/pages"])
            #expect(store.pages.count == 1)
        }

        @Test func aRateLimitedTestShowsTheServerMessage() async {
            StubURLProtocol.reset { _ in StubURLProtocol.json(429, #"{"error":{"code":"rate_limited","message":"Too many pages. Try again later."}}"#) }
            let store = PagesStore(api: api)
            await store.sendTest()
            #expect(store.lastError == "Too many pages. Try again later.")
        }
    }
}
```

`apple/PagerKit/Tests/PagerKitTests/NotificationRouteTests.swift`:

```swift
import Foundation
import Testing
import UserNotifications
@testable import PagerKit

@Suite struct NotificationRouteTests {
    let tap = UNNotificationDefaultActionIdentifier
    let open = NotificationRoute.openLinkAction

    @Test func tappingOpensThePublicPage() {
        let info: [AnyHashable: Any] = ["view_url": "https://pager.test/v/a", "url": "https://e.com"]
        #expect(NotificationRoute.url(for: info, actionIdentifier: tap) == URL(string: "https://pager.test/v/a"))
    }

    @Test func openLinkOpensTheSendersLink() {
        let info: [AnyHashable: Any] = ["view_url": "https://pager.test/v/a", "url": "https://e.com/x"]
        #expect(NotificationRoute.url(for: info, actionIdentifier: open) == URL(string: "https://e.com/x"))
    }

    @Test func openLinkFallsBackToThePageWhenTheLinkIsMissingOrUnsafe() {
        for link in [nil, "javascript:alert(1)", "file:///etc/passwd", "https:", "not a url"] as [String?] {
            var info: [AnyHashable: Any] = ["view_url": "https://pager.test/v/a"]
            if let link { info["url"] = link }
            #expect(NotificationRoute.url(for: info, actionIdentifier: open) == URL(string: "https://pager.test/v/a"))
        }
    }

    @Test func malformedPayloadsOpenNothing() {
        let payloads: [[AnyHashable: Any]] = [[:], ["view_url": 42], ["view_url": ""], ["view_url": "javascript:alert(1)"]]
        for info in payloads {
            #expect(NotificationRoute.url(for: info, actionIdentifier: tap) == nil)
        }
    }

    @Test func theLinkCategoryCarriesTheOpenLinkAction() throws {
        let category = try #require(NotificationRoute.categories().first { $0.identifier == "PAGE_WITH_LINK" })
        #expect(category.actions.map(\.identifier) == ["OPEN_LINK"])
        #expect(category.actions.first?.title == "Open link")
    }

    @Test func permissionStatusMapping() {
        #expect(NotificationPermission.status(for: .authorized) == .ready)
        #expect(NotificationPermission.status(for: .provisional) == .ready)
        #expect(NotificationPermission.status(for: .denied) == .off)
        #expect(NotificationPermission.status(for: .notDetermined) == .unknown)
    }
}
```

`apple/PagerKit/Tests/PagerKitTests/AppServicesTests.swift`:

```swift
import Foundation
import Testing
@testable import PagerKit

private let emptyPages = #"{"pages":[],"next_before":null}"#

extension Network {
    @Suite @MainActor struct AppServicesTests {
        func services(_ store: InMemorySecretStore = InMemorySecretStore()) -> AppServices {
            AppServices(baseURL: testBaseURL, environment: .sandbox, store: store, urlSession: StubURLProtocol.session())
        }

        nonisolated static func route(_ request: URLRequest) -> StubURLProtocol.Reply {
            switch request.url!.path {
            case "/api/auth/google": StubURLProtocol.json(200, #"{"session_token":"s1","email":"a@example.com"}"#)
            case "/api/devices/current": StubURLProtocol.json(200, #"{"id":"d"}"#)
            default: StubURLProtocol.json(200, emptyPages)
            }
        }

        @Test func signInRegistersAWaitingDeviceTokenThenLoadsPages() async throws {
            StubURLProtocol.reset(Self.route)
            let app = services()
            await app.registrar.didReceive(token: Data([0x0a])) // arrives before sign-in: no request
            try await app.signIn(idToken: "g")
            #expect(StubURLProtocol.requests.map(\.url!.path) == ["/api/auth/google", "/api/devices/current", "/api/pages"])
            #expect(StubURLProtocol.requests[1].value(forHTTPHeaderField: "Authorization") == "Bearer s1")
            #expect(app.session.isSignedIn)
        }

        @Test func aRevokedSessionSignsTheAppOut() async throws {
            StubURLProtocol.reset { _ in StubURLProtocol.json(401, #"{"error":{"code":"unauthorized","message":"Sign in again."}}"#) }
            let app = services(InMemorySecretStore(["session_token": "old"]))
            #expect(app.session.isSignedIn)
            await app.pages.refresh()
            for _ in 0..<50 where app.session.isSignedIn { await Task.yield() }
            #expect(!app.session.isSignedIn)
        }

        @Test func signOutForgetsPagesAndSession() async {
            StubURLProtocol.reset { _ in StubURLProtocol.json(204, "") }
            let app = services(InMemorySecretStore(["session_token": "s"]))
            await app.signOut()
            #expect(!app.session.isSignedIn)
            #expect(app.pages.pages.isEmpty)
            #expect(StubURLProtocol.requests.first?.url?.path == "/api/auth/logout")
        }

        @Test func baseURLFallsBackToProduction() {
            #expect(AppServices.baseURL(bundle: Bundle(for: StubURLProtocol.self)) == URL(string: "https://pagerio.chuut.com"))
        }
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apple/PagerKit && swift test`
Expected: FAIL to compile with "cannot find 'DeviceRegistrar' in scope".

- [ ] **Step 3: Implement `DeviceRegistrar.swift`**

```swift
import Foundation

@MainActor
public final class DeviceRegistrar {
    private let api: APIClient
    private let environment: ApnsEnvironment
    private let isSignedIn: @MainActor () -> Bool
    public private(set) var latestToken: Data?
    public private(set) var lastError: String?

    public init(api: APIClient, environment: ApnsEnvironment, isSignedIn: @escaping @MainActor () -> Bool) {
        self.api = api
        self.environment = environment
        self.isSignedIn = isSignedIn
    }

    /// Called on every launch (APNs hands the token back each time) and whenever it changes.
    public func didReceive(token: Data) async {
        latestToken = token
        await registerIfPossible()
    }

    public func registerIfPossible() async {
        guard isSignedIn(), let token = latestToken else { return }
        let registration = DeviceRegistration(
            apnsToken: DeviceToken.hex(token),
            platform: DevicePlatform.current.rawValue,
            model: DeviceModel.current,
            apnsEnv: environment.rawValue
        )
        do {
            try await api.registerDevice(registration)
            lastError = nil
        } catch {
            lastError = (error as? APIError)?.message ?? error.localizedDescription
        }
    }
}
```

- [ ] **Step 4: Implement `PagesStore.swift`**

```swift
import Observation

@MainActor @Observable
public final class PagesStore {
    public private(set) var pages: [PageSummary] = []
    public private(set) var lastError: String?
    public private(set) var isLoading = false
    private let api: APIClient

    public init(api: APIClient) {
        self.api = api
    }

    public func refresh() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            pages = try await api.pages().pages
            lastError = nil
        } catch {
            lastError = Self.describe(error)
        }
    }

    /// The server stores the page before answering 202, so an immediate refresh shows it.
    public func sendTest() async {
        do {
            try await api.sendTest()
            await refresh()
        } catch {
            lastError = Self.describe(error)
        }
    }

    public func reset() {
        pages = []
        lastError = nil
    }

    static func describe(_ error: any Error) -> String {
        (error as? APIError)?.message ?? "Couldn't reach Pocket Pager. Check your connection."
    }
}
```

- [ ] **Step 5: Implement `NotificationPermission.swift` and `NotificationRoute.swift`**

```swift
// NotificationPermission.swift
import Observation
import UserNotifications

@MainActor @Observable
public final class NotificationPermission {
    public enum Status: Equatable, Sendable {
        case unknown
        case ready
        case off
    }

    public private(set) var status: Status = .unknown

    public init() {}

    public func refresh() async {
        let authorization = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        status = Self.status(for: authorization)
    }

    public func request() async {
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
        await refresh()
    }

    public nonisolated static func status(for authorization: UNAuthorizationStatus) -> Status {
        switch authorization {
        case .authorized, .provisional: .ready
        case .denied: .off
        case .notDetermined: .unknown
        #if os(iOS)
        case .ephemeral: .ready
        #endif
        @unknown default: .unknown
        }
    }
}
```

```swift
// NotificationRoute.swift
import Foundation
import UserNotifications

public enum NotificationRoute {
    public static let openLinkAction = "OPEN_LINK"
    public static let pageWithLinkCategory = "PAGE_WITH_LINK"

    /// Where a notification interaction should take the user, or nil to just open the app.
    public static func url(for userInfo: [AnyHashable: Any], actionIdentifier: String) -> URL? {
        let page = webURL(userInfo["view_url"])
        if actionIdentifier == openLinkAction { return webURL(userInfo["url"]) ?? page }
        return page
    }

    public static func categories() -> Set<UNNotificationCategory> {
        let openLink = UNNotificationAction(identifier: openLinkAction, title: "Open link", options: [.foreground])
        return [UNNotificationCategory(identifier: pageWithLinkCategory, actions: [openLink], intentIdentifiers: [], options: [])]
    }

    static func webURL(_ value: Any?) -> URL? {
        guard let text = value as? String,
              let url = URL(string: text),
              let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http",
              url.host() != nil
        else { return nil }
        return url
    }
}
```

- [ ] **Step 6: Implement `AppServices.swift`**

```swift
import Foundation
import Observation

/// Everything an app target needs, wired once. Both apps create one at launch.
@MainActor @Observable
public final class AppServices {
    public let api: APIClient
    public let session: SessionController
    public let pages: PagesStore
    public let permission: NotificationPermission
    public let registrar: DeviceRegistrar
    public let dashboardURL: URL

    public init(baseURL: URL, environment: ApnsEnvironment, store: any SecretStore, urlSession: URLSession = .shared) {
        let session = SessionController(store: store)
        let api = APIClient(
            baseURL: baseURL,
            session: urlSession,
            tokenProvider: { store.read(SessionController.tokenKey) },
            onUnauthorized: { [weak session] in
                Task { @MainActor in session?.clear() }
            }
        )
        self.api = api
        self.session = session
        self.pages = PagesStore(api: api)
        self.permission = NotificationPermission()
        self.registrar = DeviceRegistrar(api: api, environment: environment, isSignedIn: { [weak session] in session?.isSignedIn ?? false })
        self.dashboardURL = baseURL
    }

    public func signIn(idToken: String) async throws {
        try await session.completeSignIn(idToken: idToken, api: api)
        await registrar.registerIfPossible()
        await pages.refresh()
    }

    public func signOut() async {
        await session.signOut(api: api)
        pages.reset()
    }

    /// On launch, on foreground, on wake and when the menu-bar panel opens.
    public func refreshAll() async {
        await permission.refresh()
        if session.isSignedIn { await pages.refresh() }
    }

    public nonisolated static func baseURL(bundle: Bundle = .main) -> URL {
        if let text = bundle.object(forInfoDictionaryKey: "PagerioAPIBaseURL") as? String, let url = URL(string: text), url.host() != nil {
            return url
        }
        return URL(string: "https://pagerio.chuut.com")!
    }
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd apple/PagerKit && swift test`
Expected: PASS. If Swift 6 strict concurrency rejects the `[weak session]` captures, change those closures to capture `session` strongly. Both objects live for the whole app, so this creates no leak.

- [ ] **Step 8: Commit**

```bash
git add apple/PagerKit
git commit -m "feat(pagerkit): device registration, pages store, notification routing and app services"
```

---

### Task 20: iOS app — Google sign-in, home screen, notification handling

**Files:**
- Modify: `apple/project.yml` (GoogleSignIn package, iOS Info keys), `apple/Config/Base.xcconfig` (Google client IDs)
- Replace: `apple/iOSApp/AppDelegate.swift`, `apple/iOSApp/PocketPagerApp.swift`
- Create: `apple/iOSApp/SignInView.swift`, `apple/iOSApp/HomeView.swift`
- Create: `apple/Shared/StatusLine.swift`, `apple/Shared/TestButton.swift`, `apple/Shared/PageRow.swift`

**Interfaces:**
- Consumes: `AppServices`, `NotificationRoute`, `NotificationPermission.Status`, `PageSummary`, `APIError`, and `ApnsEnvironment.current` (Shared).
- Produces (Shared views reused by Task 21): `StatusLine(status:openSettings:)`, `TestButton(pages:)`, `PageRow(page:)`.

- [ ] **Step 1: Add the Google client IDs to `apple/Config/Base.xcconfig`**

These are the clients created in Google Cloud. The reversed ID is the client ID with its parts reversed.

```
GOOGLE_CLIENT_ID_IOS = 931954287794-gcf7ob8rs8lhs17jnfijo2riagj8otf5.apps.googleusercontent.com
GOOGLE_REVERSED_CLIENT_ID_IOS = com.googleusercontent.apps.931954287794-gcf7ob8rs8lhs17jnfijo2riagj8otf5
GOOGLE_CLIENT_ID_MACOS = 931954287794-ic9vsp6ur3avk1asjnqfmee12mmpe4no.apps.googleusercontent.com
GOOGLE_REVERSED_CLIENT_ID_MACOS = com.googleusercontent.apps.931954287794-ic9vsp6ur3avk1asjnqfmee12mmpe4no
```

Place these above the `#include?` line. Client IDs are public identifiers, so committing them is safe.

- [ ] **Step 2: Update `apple/project.yml`**

Under `packages:`, add:

```yaml
  GoogleSignIn:
    url: https://github.com/google/GoogleSignIn-iOS
    majorVersion: 9.0.0
```

In `PocketPager-iOS.dependencies`, add `- package: GoogleSignIn`. In `PocketPager-iOS.info.properties`, add:

```yaml
        GIDClientID: $(GOOGLE_CLIENT_ID_IOS)
        CFBundleURLTypes:
          - CFBundleURLSchemes: [$(GOOGLE_REVERSED_CLIENT_ID_IOS)]
        ITSAppUsesNonExemptEncryption: false
```

- [ ] **Step 3: Write the shared views**

`apple/Shared/StatusLine.swift`:

```swift
import PagerKit
import SwiftUI

struct StatusLine: View {
    let status: NotificationPermission.Status
    let openSettings: () -> Void

    var body: some View {
        switch status {
        case .ready:
            Label("Ready", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
        case .off:
            VStack(alignment: .leading, spacing: 6) {
                Label("Notifications are off", systemImage: "bell.slash.fill")
                    .foregroundStyle(.orange)
                Text("Pages can't reach you until you turn them on.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Button("Open Settings", action: openSettings)
            }
        case .unknown:
            Label("Checking notifications…", systemImage: "bell")
                .foregroundStyle(.secondary)
        }
    }
}
```

`apple/Shared/TestButton.swift`:

```swift
import PagerKit
import SwiftUI

struct TestButton: View {
    let pages: PagesStore
    @State private var isSending = false

    var body: some View {
        Button {
            Task {
                isSending = true
                await pages.sendTest()
                isSending = false
            }
        } label: {
            Label(isSending ? "Sending…" : "Test my pager", systemImage: "bell.and.waves.left.and.right")
        }
        .disabled(isSending)
    }
}
```

`apple/Shared/PageRow.swift`:

```swift
import PagerKit
import SwiftUI

struct PageRow: View {
    let page: PageSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(page.headline)
                .font(.headline)
                .lineLimit(2)
            if page.title != nil {
                Text(page.message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Text(page.createdAt, format: .relative(presentation: .named))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}
```

- [ ] **Step 4: Replace `apple/iOSApp/AppDelegate.swift`**

```swift
import PagerKit
import UIKit
import UserNotifications

@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate, @preconcurrency UNUserNotificationCenterDelegate {
    let services = AppServices(
        baseURL: AppServices.baseURL(),
        environment: .current,
        store: KeychainStore(service: "com.chuut.pagerio")
    )

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories(NotificationRoute.categories())
        application.registerForRemoteNotifications()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { await services.registrar.didReceive(token: deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        print("APNs registration failed: \(error.localizedDescription)")
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        await services.pages.refresh()
        return [.banner, .sound, .list]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let userInfo = response.notification.request.content.userInfo
        if let url = NotificationRoute.url(for: userInfo, actionIdentifier: response.actionIdentifier) {
            await UIApplication.shared.open(url)
        }
    }
}
```

- [ ] **Step 5: Replace `apple/iOSApp/PocketPagerApp.swift`**

```swift
import GoogleSignIn
import PagerKit
import SwiftUI

@main
struct PocketPagerApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            RootView(services: appDelegate.services)
                .onOpenURL { GIDSignIn.sharedInstance.handle($0) }
        }
    }
}

struct RootView: View {
    let services: AppServices
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if services.session.isSignedIn {
                HomeView(services: services)
            } else {
                SignInView(services: services)
            }
        }
        .task(id: scenePhase) {
            if scenePhase == .active { await services.refreshAll() }
        }
    }
}
```

- [ ] **Step 6: Write `apple/iOSApp/SignInView.swift`**

```swift
import GoogleSignIn
import PagerKit
import SwiftUI

struct SignInView: View {
    let services: AppServices
    @State private var error: String?
    @State private var isWorking = false

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Image(systemName: "dot.radiowaves.left.and.right")
                .font(.system(size: 56))
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
            Text("Pocket Pager")
                .font(.largeTitle.bold())
            Text("Get paged on this iPhone when your scripts and agents need you.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            Spacer()
            if let error {
                Text(error)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }
            Button {
                Task { await signIn() }
            } label: {
                Text("Sign in with Google").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(isWorking)
        }
        .padding(24)
    }

    private func signIn() async {
        isWorking = true
        defer { isWorking = false }
        guard let presenter = UIApplication.shared.connectedScenes
            .compactMap({ ($0 as? UIWindowScene)?.keyWindow?.rootViewController })
            .first
        else { return }
        do {
            let result = try await GIDSignIn.sharedInstance.signIn(withPresenting: presenter)
            guard let idToken = result.user.idToken?.tokenString else {
                error = "Google didn't return an identity token. Please try again."
                return
            }
            try await services.signIn(idToken: idToken)
            error = nil
            await services.permission.request()
        } catch let googleError as GIDSignInError where googleError.code == .canceled {
            // The user closed the Google sheet: stay quietly on this screen.
        } catch {
            self.error = (error as? APIError)?.message ?? error.localizedDescription
        }
    }
}
```

- [ ] **Step 7: Write `apple/iOSApp/HomeView.swift`**

```swift
import GoogleSignIn
import PagerKit
import SwiftUI

struct HomeView: View {
    let services: AppServices
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            List {
                Section {
                    StatusLine(status: services.permission.status) {
                        openURL(URL(string: UIApplication.openSettingsURLString)!)
                    }
                    TestButton(pages: services.pages)
                }
                Section("Recent pages") {
                    if services.pages.pages.isEmpty {
                        Text("Your pager is ready.").foregroundStyle(.secondary)
                    }
                    ForEach(services.pages.pages) { page in
                        Button {
                            openURL(page.viewURL)
                        } label: {
                            PageRow(page: page)
                        }
                        .buttonStyle(.plain)
                    }
                }
                if let error = services.pages.lastError {
                    Section {
                        Text(error).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Pocket Pager")
            .refreshable { await services.pages.refresh() }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        if let email = services.session.email { Text(email) }
                        Button("Open dashboard") { openURL(services.dashboardURL) }
                        Button("Sign out", role: .destructive) {
                            Task {
                                GIDSignIn.sharedInstance.signOut()
                                await services.signOut()
                            }
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle").accessibilityLabel("More")
                    }
                }
            }
        }
    }
}
```

- [ ] **Step 8: Build for the simulator**

Run:
```bash
cd apple && xcodegen generate
xcodebuild -project PocketPager.xcodeproj -scheme PocketPager-iOS -destination 'generic/platform=iOS Simulator' build CODE_SIGNING_ALLOWED=NO -quiet
cd PagerKit && swift test
```
Expected: the build succeeds, and the PagerKit tests still pass. If `GIDSignInError` pattern matching does not compile with the resolved GoogleSignIn version, match on `(error as NSError).code == GIDSignInError.canceled.rawValue` instead.

- [ ] **Step 9: Try it on the iPhone** (manual)

Run the app from Xcode on the iPhone and check each step:
1. **Sign in with Google.** Allow notifications. The status line shows "Ready".
2. **Tap Test my pager.** A notification arrives with the sound, and the page appears in the list.
3. **Tap the notification.** Safari opens the `/v/…` page.
4. **Send a page with a link.** Run `curl -H 'Content-Type: application/json' -d '{"title":"Link test","url":"https://example.com"}' <pager URL>`, then long-press the notification and choose **Open link**. `example.com` opens.
5. **Sign out, then send another curl.** The iPhone does not receive it.

- [ ] **Step 10: Commit**

```bash
git add apple
git commit -m "feat(ios): Google sign-in, home screen with status, test button and recent pages"
```

---

### Task 21: macOS menu-bar app

**Files:**
- Modify: `apple/project.yml` (GoogleSignIn dependency, macOS Info keys, keychain entitlements)
- Replace: `apple/MacApp/AppDelegate.swift`, `apple/MacApp/PocketPagerMacApp.swift`
- Create: `apple/MacApp/MenuPanel.swift`, `apple/MacApp/SignInWindow.swift`, `apple/MacApp/LoginItem.swift`
- Delete: `apple/Shared/PushTokenModel.swift`, `apple/Shared/PushTokenView.swift`, `apple/Shared/Clipboard.swift` (phase 1 scaffolding, now unused)

**Interfaces:**
- Consumes: `AppServices`, `NotificationRoute`, `StatusLine`, `TestButton`, `PageRow`.
- Produces: a menu-bar app with a sign-in window and Launch at login.

- [ ] **Step 1: Update `apple/project.yml` for the Mac target**

In `PocketPager-macOS.dependencies`, add `- package: GoogleSignIn`. In `PocketPager-macOS.info.properties`, add:

```yaml
        GIDClientID: $(GOOGLE_CLIENT_ID_MACOS)
        CFBundleURLTypes:
          - CFBundleURLSchemes: [$(GOOGLE_REVERSED_CLIENT_ID_MACOS)]
        ITSAppUsesNonExemptEncryption: false
```

In `PocketPager-macOS.entitlements.properties`, add the keychain groups. The first group is ours; GoogleSignIn requires the second.

```yaml
        keychain-access-groups:
          - $(AppIdentifierPrefix)com.chuut.pagerio.mac
          - $(AppIdentifierPrefix)com.google.GIDSignIn
```

- [ ] **Step 2: Remove the phase 1 scaffolding**

```bash
git rm apple/Shared/PushTokenModel.swift apple/Shared/PushTokenView.swift apple/Shared/Clipboard.swift
```

- [ ] **Step 3: Write `apple/MacApp/LoginItem.swift`**

```swift
import ServiceManagement

enum LoginItem {
    static var isEnabled: Bool { SMAppService.mainApp.status == .enabled }

    static func set(_ enabled: Bool) {
        do {
            if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            print("Launch at login: \(error.localizedDescription)")
        }
    }
}
```

- [ ] **Step 4: Replace `apple/MacApp/AppDelegate.swift`**

```swift
import AppKit
import GoogleSignIn
import PagerKit
import UserNotifications

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, @preconcurrency UNUserNotificationCenterDelegate {
    let services = AppServices(
        baseURL: AppServices.baseURL(),
        environment: .current,
        store: KeychainStore(service: "com.chuut.pagerio.mac")
    )

    func applicationDidFinishLaunching(_ notification: Notification) {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories(NotificationRoute.categories())
        NSApplication.shared.registerForRemoteNotifications()
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [services] _ in
            Task { @MainActor in await services.refreshAll() }
        }
        Task { await services.refreshAll() }
    }

    func application(_ application: NSApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { await services.registrar.didReceive(token: deviceToken) }
    }

    func application(_ application: NSApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        print("APNs registration failed: \(error.localizedDescription)")
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls { GIDSignIn.sharedInstance.handle(url) }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        await services.pages.refresh()
        return [.banner, .sound, .list]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let userInfo = response.notification.request.content.userInfo
        if let url = NotificationRoute.url(for: userInfo, actionIdentifier: response.actionIdentifier) {
            NSWorkspace.shared.open(url)
        }
    }
}
```

- [ ] **Step 5: Write `apple/MacApp/SignInWindow.swift`**

```swift
import AppKit
import GoogleSignIn
import PagerKit
import SwiftUI

struct SignInWindow: View {
    static let id = "signin"
    let services: AppServices
    @Environment(\.dismissWindow) private var dismissWindow
    @State private var error: String?
    @State private var isWorking = false

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "dot.radiowaves.left.and.right")
                .font(.system(size: 44))
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
            Text("Pocket Pager").font(.title.bold())
            Text("Sign in to get paged on this Mac.")
                .foregroundStyle(.secondary)
            if let error {
                Text(error)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }
            Button("Sign in with Google") { Task { await signIn() } }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(isWorking)
        }
        .padding(32)
        .frame(width: 360)
        .onAppear { NSApp.activate() }
    }

    private func signIn() async {
        isWorking = true
        defer { isWorking = false }
        guard let window = NSApp.keyWindow ?? NSApp.windows.first(where: \.isVisible) else { return }
        do {
            let result = try await GIDSignIn.sharedInstance.signIn(withPresenting: window)
            guard let idToken = result.user.idToken?.tokenString else {
                error = "Google didn't return an identity token. Please try again."
                return
            }
            try await services.signIn(idToken: idToken)
            await services.permission.request()
            LoginItem.set(true) // a pager that isn't running can't show its menu
            dismissWindow(id: Self.id)
        } catch let googleError as GIDSignInError where googleError.code == .canceled {
            // Closed the Google window: stay here.
        } catch {
            self.error = (error as? APIError)?.message ?? error.localizedDescription
        }
    }
}
```

- [ ] **Step 6: Write `apple/MacApp/MenuPanel.swift`**

```swift
import AppKit
import GoogleSignIn
import PagerKit
import SwiftUI

struct MenuPanel: View {
    let services: AppServices
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openURL) private var openURL
    @State private var launchAtLogin = LoginItem.isEnabled

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if services.session.isSignedIn {
                StatusLine(status: services.permission.status) {
                    openURL(URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension")!)
                }
                TestButton(pages: services.pages)
                Divider()
                if services.pages.pages.isEmpty {
                    Text("Your pager is ready.").foregroundStyle(.secondary)
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 10) {
                            ForEach(services.pages.pages.prefix(20)) { page in
                                Button {
                                    openURL(page.viewURL)
                                } label: {
                                    PageRow(page: page)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    .frame(maxHeight: 320)
                }
                if let error = services.pages.lastError {
                    Text(error).font(.caption).foregroundStyle(.red)
                }
                Divider()
                Toggle("Launch at login", isOn: $launchAtLogin)
                    .onChange(of: launchAtLogin) { _, enabled in
                        LoginItem.set(enabled)
                        launchAtLogin = LoginItem.isEnabled
                    }
                HStack {
                    Button("Open dashboard") { openURL(services.dashboardURL) }
                    Spacer()
                    Button("Sign out") {
                        Task {
                            GIDSignIn.sharedInstance.signOut()
                            await services.signOut()
                        }
                    }
                }
            } else {
                Text("You're signed out.").foregroundStyle(.secondary)
                Button("Sign in…") {
                    openWindow(id: SignInWindow.id)
                    NSApp.activate()
                }
            }
            Divider()
            Button("Quit Pocket Pager") { NSApp.terminate(nil) }
        }
        .padding(14)
        .frame(width: 340)
        .task { await services.refreshAll() }
    }
}
```

- [ ] **Step 7: Replace `apple/MacApp/PocketPagerMacApp.swift`**

```swift
import PagerKit
import SwiftUI

@main
struct PocketPagerMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        MenuBarExtra {
            MenuPanel(services: appDelegate.services)
        } label: {
            Image(systemName: "dot.radiowaves.left.and.right")
                .accessibilityLabel("Pocket Pager")
        }
        .menuBarExtraStyle(.window)

        Window("Sign in to Pocket Pager", id: SignInWindow.id) {
            SignInWindow(services: appDelegate.services)
        }
        .windowResizability(.contentSize)
        .defaultLaunchBehavior(appDelegate.services.session.isSignedIn ? .suppressed : .presented)
    }
}
```

- [ ] **Step 8: Build both apps and run the package tests**

```bash
cd apple && xcodegen generate
xcodebuild -project PocketPager.xcodeproj -scheme PocketPager-macOS -destination 'platform=macOS' build CODE_SIGNING_ALLOWED=NO -quiet
xcodebuild -project PocketPager.xcodeproj -scheme PocketPager-iOS -destination 'generic/platform=iOS Simulator' build CODE_SIGNING_ALLOWED=NO -quiet
cd PagerKit && swift test
```

Expected: both builds succeed, and the tests pass.

- [ ] **Step 9: Try it on the Mac** (manual, run from Xcode with signing)

Check each step:
1. **First launch** opens the sign-in window. After sign-in, the window closes and the menu-bar icon shows "Ready".
2. **Test my pager** produces a banner with the sound, and the page appears in the panel.
3. **Clicking the banner** opens `/v/…` in the default browser.
4. **Launch at login** is on. Quit and relaunch: there is no sign-in window, and you are still signed in.
5. **Sleep, then wake:** open the panel and confirm it shows pages sent during sleep.

- [ ] **Step 10: Commit**

```bash
git add -A apple
git commit -m "feat(macos): menu-bar app with Google sign-in window, recent pages and launch at login"
```

---

### Task 22: Phase 2 milestone — TestFlight and end-to-end check (manual)

**Files:**
- Create: `apple/iOSApp/Assets.xcassets/Contents.json`, `apple/iOSApp/Assets.xcassets/AppIcon.appiconset/Contents.json` and `icon-1024.png`
- Create: `apple/MacApp/Assets.xcassets/Contents.json`, `apple/MacApp/Assets.xcassets/AppIcon.appiconset/Contents.json` and the generated PNGs

- [ ] **Step 1: App icons.** The user supplies a 1024×1024 PNG, `icon-1024.png`. A placeholder is fine for TestFlight.

```bash
cd apple
for dir in iOSApp MacApp; do
  mkdir -p $dir/Assets.xcassets/AppIcon.appiconset
  echo '{"info":{"author":"xcode","version":1}}' > $dir/Assets.xcassets/Contents.json
done
cp ~/Downloads/icon-1024.png iOSApp/Assets.xcassets/AppIcon.appiconset/icon-1024.png
cat > iOSApp/Assets.xcassets/AppIcon.appiconset/Contents.json <<'EOF'
{"images":[{"filename":"icon-1024.png","idiom":"universal","platform":"ios","size":"1024x1024"}],"info":{"author":"xcode","version":1}}
EOF
cd MacApp/Assets.xcassets/AppIcon.appiconset
for s in 16 32 128 256 512; do
  sips -z $s $s ~/Downloads/icon-1024.png --out icon_${s}.png >/dev/null
  sips -z $((s*2)) $((s*2)) ~/Downloads/icon-1024.png --out icon_${s}@2x.png >/dev/null
done
python3 - <<'EOF'
import json
images = []
for s in (16, 32, 128, 256, 512):
    images.append({"filename": f"icon_{s}.png", "idiom": "mac", "scale": "1x", "size": f"{s}x{s}"})
    images.append({"filename": f"icon_{s}@2x.png", "idiom": "mac", "scale": "2x", "size": f"{s}x{s}"})
json.dump({"images": images, "info": {"author": "xcode", "version": 1}}, open("Contents.json", "w"))
EOF
cd ../../.. && xcodegen generate
```

Both targets already include their folders as sources, so XcodeGen picks up the asset catalogs, and `AppIcon` is the default icon name.

- [ ] **Step 2: App Store Connect.** The user creates two apps: **Pocket Pager** for iOS with bundle ID `com.chuut.pagerio`, and **Pocket Pager** for macOS with bundle ID `com.chuut.pagerio.mac`.

- [ ] **Step 3: Archive and upload.** In Xcode, select the scheme, choose **Any iOS Device (arm64)** (or **My Mac**), then **Product › Archive** and **Distribute App › TestFlight & App Store**. Do this for both schemes. Automatic signing switches `aps-environment` to production in the archive.

- [ ] **Step 4: Install through TestFlight** on the iPhone and the Mac (internal testers need no review). Open each app and sign in with the same Google account. TestFlight builds register with `apns_env = production`, so they use the production APNs host.

- [ ] **Step 5: End-to-end milestone.** From a terminal:

```bash
curl -d "Phase 2 milestone" <pager URL>
```

Expected: the iPhone and the Mac both sound within a few seconds, and the page appears in both apps and on the dashboard.

- [ ] **Step 6: Real-device checklist** (record the results for the user):
  - iPhone locked; app killed; Focus on with Time Sensitive allowed; Focus on with Time Sensitive blocked.
  - Mac asleep, then woken; Mac app quit (the banner still arrives because APNs delivers it; the history refreshes on next launch).
  - Airplane mode on, page sent, airplane mode off: the notification arrives if it is under one hour old, and the history always shows it.
  - An Xcode (sandbox) build and a TestFlight (production) build signed into the same account both receive the page.
  - Sign out on the iPhone, then send a page: only the Mac receives it.
  - The `view_url` from the curl response opens in a private browser window without signing in.

- [ ] **Step 7: Commit the icons**

```bash
git add apple
git commit -m "chore(apple): app icons for TestFlight"
```
