import { hashToken, isTokenShaped, newId, randomToken } from "../auth/tokens";
import type { Ctx } from "../context";
import { deleteDevice } from "../db/devices";
import { deleteSession, getSessionByHash, insertSession, type SessionKind, type SessionRow, touchSession } from "../db/sessions";

export type { SessionKind, SessionRow };

export const SESSION_IDLE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export function createSession(ctx: Ctx, accountId: string, kind: SessionKind): { token: string; session: SessionRow } {
  const token = randomToken();
  const now = ctx.now();
  const session: SessionRow = {
    id: newId("ses"),
    account_id: accountId,
    kind,
    device_id: null,
    token_hash: hashToken(token),
    created_at: now,
    last_used_at: now,
  };
  insertSession(ctx.db, session);
  return { token, session };
}

export function resolveSession(ctx: Ctx, token: string, kind: SessionKind): SessionRow | null {
  if (!isTokenShaped(token)) return null;
  const session = getSessionByHash(ctx.db, hashToken(token));
  if (!session || session.kind !== kind) return null;
  const now = ctx.now();
  if (now - session.last_used_at > SESSION_IDLE_TTL_MS) {
    deleteSession(ctx.db, session.id);
    return null;
  }
  touchSession(ctx.db, session.id, now);
  return { ...session, last_used_at: now };
}

/** App sign-out removes the device too (its session cascades), so a signed-out phone stops getting pages. */
export function revokeSession(ctx: Ctx, session: SessionRow): void {
  ctx.db.transaction(() => {
    if (session.kind === "app" && session.device_id) deleteDevice(ctx.db, session.device_id);
    deleteSession(ctx.db, session.id);
  })();
}
