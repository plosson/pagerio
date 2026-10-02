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
 * The server runs behind Cloudflare and Traefik (siteio). Each proxy appends the address
 * it saw to X-Forwarded-For, so only the rightmost entry (added by our own proxy) is
 * trustworthy; anything to its left is client-controlled. When traffic is proxied, that
 * address is the Cloudflare edge, not the end client, so it identifies an edge node and
 * is too coarse to rate-limit real users. The limiter is therefore only used for
 * unknown-token requests (see trigger.ts).
 */
export function clientIp(c: Context): string {
  const entries = (c.req.header("x-forwarded-for") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return entries.at(-1) ?? "unknown";
}
