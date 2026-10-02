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
