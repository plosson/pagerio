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
