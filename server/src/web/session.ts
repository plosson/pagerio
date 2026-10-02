import { createHash } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { constantTimeEqual } from "../auth/tokens";
import type { Config } from "../config";
import type { Ctx } from "../context";
import { resolveSession, SESSION_IDLE_TTL_MS, type SessionRow } from "../services/sessions";

export const SESSION_COOKIE = "pp_session";
export const STATE_COOKIE = "pp_oauth_state";

const isSecure = (config: Config) => config.publicBaseUrl.startsWith("https://");

export function setSessionCookie(c: Context, config: Config, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isSecure(config),
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(SESSION_IDLE_TTL_MS / 1000),
  });
}

export function clearSessionCookie(c: Context, config: Config): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: isSecure(config) });
}

export function setStateCookie(c: Context, config: Config, state: string): void {
  setCookie(c, STATE_COOKIE, state, { httpOnly: true, secure: isSecure(config), sameSite: "Lax", path: "/auth", maxAge: 600 });
}

/** Reads the OAuth state cookie and clears it: a state is single-use. */
export function takeStateCookie(c: Context, config: Config): string | undefined {
  const value = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: "/auth", secure: isSecure(config) });
  return value;
}

export interface WebSession {
  session: SessionRow;
  csrf: string;
}

export function csrfTokenFor(sessionToken: string): string {
  return createHash("sha256").update(`csrf:${sessionToken}`).digest("base64url");
}

export function currentWebSession(ctx: Ctx, c: Context): WebSession | null {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const session = resolveSession(ctx, token, "web");
  return session ? { session, csrf: csrfTokenFor(token) } : null;
}

export async function hasValidCsrf(c: Context, web: WebSession): Promise<boolean> {
  const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
  return typeof body._csrf === "string" && constantTimeEqual(body._csrf, web.csrf);
}
