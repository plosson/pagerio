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

// Short tokens end up in URLs people copy by hand (/p/ and /v/), so they are short and purely alphanumeric
// ('-' and '_' break double-click selection). 16 base62 chars ≈ 95 bits, ample for an online-only guess.
const SHORT_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const SHORT_TOKEN_LENGTH = 16;
const SHORT_TOKEN_PATTERN = /^[A-Za-z0-9]{16}$/;

export function randomShortToken(): string {
  let token = "";
  while (token.length < SHORT_TOKEN_LENGTH) {
    for (const byte of randomBytes(SHORT_TOKEN_LENGTH)) {
      // Reject bytes >= 248 (4 × 62) so every character is equally likely.
      if (byte < 248 && token.length < SHORT_TOKEN_LENGTH) token += SHORT_ALPHABET[byte % 62];
    }
  }
  return token;
}

export function isShortTokenShaped(value: string): boolean {
  return SHORT_TOKEN_PATTERN.test(value);
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
