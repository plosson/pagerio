import { describe, expect, test } from "bun:test";
import { capCombiningMarks, DEFAULT_MESSAGE, parseTriggerBody } from "../../src/services/pageInput";

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

  test("urls are stored normalized", () => {
    expect(json({ url: "https://Example.com" })).toMatchObject({ ok: true, value: { url: "https://example.com/" } });
    expect(json({ url: "http:example.com" })).toMatchObject({ ok: true, value: { url: "http://example.com/" } });
    expect(json({ url: " HTTPS://E.com/a b " })).toMatchObject({ ok: true, value: { url: "https://e.com/a%20b" } });
  });

  test("rejects a url whose normalized form exceeds 2,048 characters", () => {
    // 700 spaces fit in the raw limit but each becomes %20 once normalized.
    expect(json({ url: "https://e.com/" + " ".repeat(700) + "a".repeat(10) }).ok).toBe(false);
    expect(json({ url: "https://e.com/" + "\u00e9".repeat(700) }).ok).toBe(false);
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

describe("combining marks", () => {
  const zalgo = "Z" + "́̂̃̄̅̆".repeat(20) + "algo";

  test("Zalgo text keeps at most two marks per base character", () => {
    const capped = capCombiningMarks(zalgo);
    expect(capped).toBe("Ź̂algo");
    expect([...capped].filter((c) => /\p{M}/u.test(c))).toHaveLength(2);
  });

  test("marks with no base character at the start are capped too", () => {
    expect(capCombiningMarks("́́́́x")).toBe("́́x");
  });

  test("legitimate text survives unchanged: accents, Vietnamese, Arabic, emoji, keycaps, flags and ZWJ", () => {
    for (const text of ["Café déjà vu", "Tiếng Việt", "فشل النشر", "1️⃣", "👨‍👩‍👧 🇧🇪 👍🏽 ❤️", "é"]) {
      expect(capCombiningMarks(text)).toBe(text);
    }
  });

  test("plain bodies, titles, messages and details are capped at ingest", () => {
    const plain = parseTriggerBody("text/plain", enc(zalgo));
    expect(plain.ok && plain.value.message).toBe("Ź̂algo");
    const parsed = json({ title: zalgo, message: zalgo, details: zalgo });
    expect(parsed.ok && [parsed.value.title, parsed.value.message, parsed.value.details]).toEqual(Array(3).fill("Ź̂algo"));
  });

  test("a Zalgo title longer than the limit before capping is accepted once capped", () => {
    const long = "a" + "́".repeat(500);
    const parsed = json({ title: long });
    expect(parsed.ok && parsed.value.title).toBe("á́");
  });

  test("URLs and group keys are never rewritten", () => {
    const parsed = json({ url: "https://example.com/é́́", group: "ǵ́́" });
    expect(parsed.ok && parsed.value.url).toBe(new URL("https://example.com/é́́").href);
    expect(parsed.ok && parsed.value.group).toBe("ǵ́́");
  });
});
