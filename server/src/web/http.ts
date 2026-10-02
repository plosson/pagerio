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
