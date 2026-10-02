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
