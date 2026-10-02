import { Hono } from "hono";
import type { AppDeps } from "../app";
import { AuthError } from "../auth/google";
import type { Config } from "../config";
import { findOrCreateAccount, type Identity } from "../services/accounts";
import { parseDeviceInput, registerCurrentDevice } from "../services/devices";
import { createPage, listPagesForAccount, type PageRow, TEST_PAGE_INPUT, viewUrl } from "../services/pages";
import { createSession, resolveSession, revokeSession, type SessionRow } from "../services/sessions";
import { acceptedJson, errorJson, rateLimitedJson } from "./responses";

type Env = { Variables: { session: SessionRow } };

function pageJson(config: Config, page: PageRow) {
  return {
    id: page.id,
    title: page.title,
    message: page.message,
    url: page.url,
    view_url: viewUrl(config, page.public_id),
    source: page.source,
    created_at: new Date(page.created_at).toISOString(),
  };
}

export function appApiRoutes(deps: AppDeps): Hono<Env> {
  const api = new Hono<Env>();

  // Registered before the auth middleware: this is the only unauthenticated route.
  api.post("/auth/google", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { id_token?: unknown } | null;
    if (!body || typeof body.id_token !== "string" || body.id_token === "") {
      return errorJson(c, 400, "invalid_input", "id_token is required.");
    }
    let identity: Identity;
    try {
      identity = await deps.google.verify(body.id_token);
    } catch (err) {
      if (err instanceof AuthError) return errorJson(c, 401, "unauthorized", "Google sign-in could not be verified.");
      throw err;
    }
    const account = findOrCreateAccount(deps, identity);
    const { token } = createSession(deps, account.id, "app");
    return c.json({ session_token: token, email: account.email });
  });

  api.use("*", async (c, next) => {
    const match = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "");
    const session = match ? resolveSession(deps, match[1]!, "app") : null;
    if (!session) return errorJson(c, 401, "unauthorized", "Sign in again.");
    c.set("session", session);
    await next();
  });

  api.post("/auth/logout", (c) => {
    revokeSession(deps, c.get("session"));
    return c.body(null, 204);
  });

  api.put("/devices/current", async (c) => {
    const parsed = parseDeviceInput(await c.req.json().catch(() => null));
    if (!parsed.ok) return errorJson(c, 400, "invalid_input", parsed.message);
    const device = registerCurrentDevice(deps, c.get("session"), parsed.value);
    return c.json({ id: device.id });
  });

  api.get("/pages", (c) => {
    const rawLimit = c.req.query("limit");
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return errorJson(c, 400, "invalid_input", "limit must be an integer from 1 to 100.");
    }
    const result = listPagesForAccount(deps, c.get("session").account_id, { beforeId: c.req.query("before") || null, limit });
    if (!result.ok) return errorJson(c, 400, "invalid_input", result.message);
    return c.json({ pages: result.pages.map((page) => pageJson(deps.config, page)), next_before: result.nextBefore });
  });

  api.post("/test", (c) => {
    const result = createPage(deps, { accountId: c.get("session").account_id, input: TEST_PAGE_INPUT, source: "test", idempotencyKey: null });
    if (!result.ok) return rateLimitedJson(c, result.retryAfterSeconds, "Too many pages. Try again later.");
    deps.worker.wake();
    return acceptedJson(c, deps.config, result.page);
  });

  return api;
}
