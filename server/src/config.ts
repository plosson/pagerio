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
