import { Hono } from "hono";
import type { AppDeps } from "../app";
import { AuthError } from "../auth/google";
import { constantTimeEqual, randomToken } from "../auth/tokens";
import { findOrCreateAccount, type Identity } from "../services/accounts";
import { createSession, revokeSession } from "../services/sessions";
import { renderHtml } from "./http";
import { MessagePage } from "./layout";
import { clearSessionCookie, currentWebSession, hasValidCsrf, setSessionCookie, setStateCookie, takeStateCookie } from "./session";

export function webAuthRoutes(deps: AppDeps): Hono {
  const routes = new Hono();

  routes.get("/auth/google", (c) => {
    const state = randomToken();
    setStateCookie(c, deps.config, state);
    return c.redirect(deps.googleOAuth.authorizationUrl(state), 302);
  });

  routes.get("/auth/google/callback", async (c) => {
    const expected = takeStateCookie(c, deps.config);
    if (c.req.query("error")) return c.redirect("/", 303);
    const state = c.req.query("state");
    const code = c.req.query("code");
    if (!expected || !state || !code || !constantTimeEqual(state, expected)) {
      return renderHtml(c, <MessagePage title="Sign-in expired" text="Your sign-in attempt expired. Please try again." />, 400);
    }
    let identity: Identity;
    try {
      identity = await deps.google.verify(await deps.googleOAuth.exchangeCode(code));
    } catch (err) {
      if (err instanceof AuthError) {
        return renderHtml(c, <MessagePage title="Sign-in failed" text="Google sign-in could not be verified. Please try again." />, 401);
      }
      throw err;
    }
    const account = findOrCreateAccount(deps, identity);
    const { token } = createSession(deps, account.id, "web");
    setSessionCookie(c, deps.config, token);
    return c.redirect("/", 303);
  });

  routes.post("/auth/logout", async (c) => {
    const web = currentWebSession(deps, c);
    if (web && (await hasValidCsrf(c, web))) {
      revokeSession(deps, web.session);
      clearSessionCookie(c, deps.config);
    }
    return c.redirect("/", 303);
  });

  return routes;
}
