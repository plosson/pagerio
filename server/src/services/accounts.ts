import { decryptSecret, encryptSecret, hashToken, isTokenShaped, newId, randomToken } from "../auth/tokens";
import type { Ctx } from "../context";
import {
  type AccountRow,
  getAccountByGoogleSub,
  getAccountById,
  getAccountByTriggerHash,
  insertAccount,
  updateAccountEmail,
} from "../db/accounts";

export type { AccountRow };

export interface Identity {
  sub: string;
  email: string;
}

export function findOrCreateAccount(ctx: Ctx, identity: Identity): AccountRow {
  return ctx.db.transaction(() => {
    const existing = getAccountByGoogleSub(ctx.db, identity.sub);
    if (existing) {
      if (existing.email !== identity.email) updateAccountEmail(ctx.db, existing.id, identity.email);
      return { ...existing, email: identity.email };
    }
    const token = randomToken();
    const row: AccountRow = {
      id: newId("acct"),
      google_sub: identity.sub,
      email: identity.email,
      trigger_token_hash: hashToken(token),
      trigger_token_enc: encryptSecret(ctx.config.tokenEncKey, token),
      created_at: ctx.now(),
    };
    insertAccount(ctx.db, row);
    return row;
  })();
}

export function findAccountByTriggerToken(ctx: Ctx, token: string): AccountRow | null {
  if (!isTokenShaped(token)) return null;
  return getAccountByTriggerHash(ctx.db, hashToken(token));
}

export function triggerUrl(ctx: Ctx, accountId: string): string {
  const account = getAccountById(ctx.db, accountId);
  if (!account) throw new Error("Account not found");
  return `${ctx.config.publicBaseUrl}/p/${decryptSecret(ctx.config.tokenEncKey, account.trigger_token_enc)}`;
}
