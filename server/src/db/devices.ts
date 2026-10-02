import type { Database } from "bun:sqlite";
import type { ApnsEnv, Platform } from "../config";

export type DeviceRow = {
  id: string;
  account_id: string;
  platform: Platform;
  model: string;
  apns_token: string;
  apns_env: ApnsEnv;
  created_at: number;
  last_seen_at: number;
};

export function insertDevice(db: Database, row: DeviceRow): void {
  db.query(
    `INSERT INTO devices (id, account_id, platform, model, apns_token, apns_env, created_at, last_seen_at)
     VALUES ($id, $account_id, $platform, $model, $apns_token, $apns_env, $created_at, $last_seen_at)`,
  ).run(row);
}

export function getDevice(db: Database, id: string): DeviceRow | null {
  return db.query<DeviceRow, { id: string }>("SELECT * FROM devices WHERE id = $id").get({ id }) ?? null;
}

export function getDeviceByToken(db: Database, token: string): DeviceRow | null {
  return db.query<DeviceRow, { token: string }>("SELECT * FROM devices WHERE apns_token = $token").get({ token }) ?? null;
}

export function updateDevice(
  db: Database,
  id: string,
  fields: Pick<DeviceRow, "platform" | "model" | "apns_token" | "apns_env" | "last_seen_at">,
): void {
  db.query(
    `UPDATE devices SET platform = $platform, model = $model, apns_token = $apns_token,
       apns_env = $apns_env, last_seen_at = $last_seen_at WHERE id = $id`,
  ).run({ id, ...fields });
}

export function deleteDevice(db: Database, id: string): void {
  db.query("DELETE FROM devices WHERE id = $id").run({ id });
}

export function listDevicesForAccount(db: Database, accountId: string): DeviceRow[] {
  return db
    .query<DeviceRow, { accountId: string }>("SELECT * FROM devices WHERE account_id = $accountId ORDER BY created_at")
    .all({ accountId });
}
