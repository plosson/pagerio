import { Hono } from "hono";
import type { AppDeps } from "../app";
import { isShortTokenShaped } from "../auth/tokens";
import { findAccountByTriggerToken } from "../services/accounts";
import { LIMITS, parseTriggerBody } from "../services/pageInput";
import { createPage } from "../services/pages";
import { clientIp } from "./ipLimiter";
import { acceptedJson, errorJson, rateLimitedJson } from "./responses";
import { triggerGuideMarkdown } from "./triggerGuide";

export function triggerRoutes(deps: AppDeps): Hono {
  const routes = new Hono();

  routes.post("/p/:token", async (c) => {
    const tooLarge = () => errorJson(c, 413, "payload_too_large", `Request body must be at most ${LIMITS.bodyBytes} bytes.`);
    if (Number(c.req.header("content-length") ?? 0) > LIMITS.bodyBytes) return tooLarge();

    const account = findAccountByTriggerToken(deps, c.req.param("token"));
    if (!account) {
      // Only token guesses count against the per-IP limit: behind Cloudflare the IP is a shared edge address,
      // so limiting valid tokens would let anyone flooding unknown tokens lock out legitimate triggers.
      const ip = deps.ipLimiter.hit(clientIp(c));
      if (!ip.ok) return rateLimitedJson(c, ip.retryAfterSeconds, "Too many requests. Slow down.");
      return errorJson(c, 404, "not_found", "Unknown pager URL.");
    }

    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.length > LIMITS.bodyBytes) return tooLarge();

    const idempotencyKey = c.req.header("idempotency-key")?.trim() || null;
    if (idempotencyKey && idempotencyKey.length > LIMITS.idempotencyKey) {
      return errorJson(c, 400, "invalid_input", `Idempotency-Key must be at most ${LIMITS.idempotencyKey} characters.`);
    }

    const parsed = parseTriggerBody(c.req.header("content-type"), body);
    if (!parsed.ok) return errorJson(c, 400, "invalid_input", parsed.message);

    const result = createPage(deps, { accountId: account.id, input: parsed.value, source: "trigger", idempotencyKey });
    if (!result.ok) return rateLimitedJson(c, result.retryAfterSeconds, "Too many pages. Try again later.");
    deps.worker.wake();
    return acceptedJson(c, deps.config, result.page);
  });

  // GET never sends a page (link previews, scanners). It returns a usage guide for agents and humans who curl the URL.
  // The token is not looked up, so the guide is the same for every token and reveals nothing about which ones exist.
  routes.get("/p/:token", (c) => {
    const token = c.req.param("token");
    const url = `${deps.config.publicBaseUrl}/p/${isShortTokenShaped(token) ? token : "<token>"}`;
    return c.body(triggerGuideMarkdown(url, deps.config.limits), 200, { "Content-Type": "text/markdown; charset=utf-8" });
  });

  routes.all("/p/:token", (c) => errorJson(c, 405, "method_not_allowed", "Use POST to send a page, or GET for usage instructions.", { Allow: "GET, POST" }));

  return routes;
}
