import { describe, expect, test } from "bun:test";
import {
  constantTimeEqual,
  decryptSecret,
  encryptSecret,
  hashToken,
  isTokenShaped,
  isShortTokenShaped,
  newId,
  randomToken,
  randomShortToken,
} from "../../src/auth/tokens";

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

describe("randomShortToken", () => {
  test("is 16 alphanumeric characters (no '-' or '_') and never repeats in 2,000 draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const t = randomShortToken();
      expect(t).toMatch(/^[A-Za-z0-9]{16}$/);
      expect(isShortTokenShaped(t)).toBe(true);
      seen.add(t);
    }
    expect(seen.size).toBe(2000);
  });

  test("uses every alphabet character with no visible bias", () => {
    const counts = new Map<string, number>();
    const draws = 5000;
    for (let i = 0; i < draws; i++) for (const ch of randomShortToken()) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    expect(counts.size).toBe(62);
    const expected = (draws * 16) / 62;
    for (const n of counts.values()) {
      expect(n).toBeGreaterThan(expected * 0.75);
      expect(n).toBeLessThan(expected * 1.25);
    }
  });

  test("isShortTokenShaped rejects anything else, including legacy 43-char tokens", () => {
    for (const bad of [
      "",
      "a".repeat(15),
      "a".repeat(17),
      "a".repeat(15) + "-",
      "a".repeat(15) + "_",
      "a".repeat(15) + "=",
      "a".repeat(15) + "é",
      "../../aaaaaaaaaa",
      " " + "a".repeat(15),
      "a".repeat(16) + "\n",
      randomToken(),
    ]) {
      expect(isShortTokenShaped(bad)).toBe(false);
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
