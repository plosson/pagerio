import type { Database } from "bun:sqlite";

export type AccountRow = {
  id: string;
  google_sub: string;
  email: string;
  trigger_token_hash: string;
  trigger_token_enc: string;
  created_at: number;
};

export function insertAccount(db: Database, row: AccountRow): void {
  db.query(
    `INSERT INTO accounts (id, google_sub, email, trigger_token_hash, trigger_token_enc, created_at)
     VALUES ($id, $google_sub, $email, $trigger_token_hash, $trigger_token_enc, $created_at)`,
  ).run(row);
}

export function getAccountById(db: Database, id: string): AccountRow | null {
  return db.query<AccountRow, { id: string }>("SELECT * FROM accounts WHERE id = $id").get({ id }) ?? null;
}

export function getAccountByGoogleSub(db: Database, sub: string): AccountRow | null {
  return db.query<AccountRow, { sub: string }>("SELECT * FROM accounts WHERE google_sub = $sub").get({ sub }) ?? null;
}

export function getAccountByTriggerHash(db: Database, hash: string): AccountRow | null {
  return db.query<AccountRow, { hash: string }>("SELECT * FROM accounts WHERE trigger_token_hash = $hash").get({ hash }) ?? null;
}

export function updateAccountEmail(db: Database, id: string, email: string): void {
  db.query("UPDATE accounts SET email = $email WHERE id = $id").run({ id, email });
}
