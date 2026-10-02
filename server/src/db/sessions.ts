import type { Database } from "bun:sqlite";

export type SessionKind = "web" | "app";

export type SessionRow = {
  id: string;
  account_id: string;
  kind: SessionKind;
  device_id: string | null;
  token_hash: string;
  created_at: number;
  last_used_at: number;
};

export function insertSession(db: Database, row: SessionRow): void {
  db.query(
    `INSERT INTO sessions (id, account_id, kind, device_id, token_hash, created_at, last_used_at)
     VALUES ($id, $account_id, $kind, $device_id, $token_hash, $created_at, $last_used_at)`,
  ).run(row);
}

export function getSessionByHash(db: Database, hash: string): SessionRow | null {
  return db.query<SessionRow, { hash: string }>("SELECT * FROM sessions WHERE token_hash = $hash").get({ hash }) ?? null;
}

export function touchSession(db: Database, id: string, at: number): void {
  db.query("UPDATE sessions SET last_used_at = $at WHERE id = $id").run({ id, at });
}

export function deleteSession(db: Database, id: string): void {
  db.query("DELETE FROM sessions WHERE id = $id").run({ id });
}

export function setSessionDevice(db: Database, id: string, deviceId: string): void {
  db.query("UPDATE sessions SET device_id = $deviceId WHERE id = $id").run({ id, deviceId });
}
