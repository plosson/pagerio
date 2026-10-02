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
