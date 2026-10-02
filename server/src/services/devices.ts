import { newId } from "../auth/tokens";
import type { ApnsEnv, Platform } from "../config";
import type { Ctx } from "../context";
import { type DeviceRow, deleteDevice, getDevice, getDeviceByToken, insertDevice, listDevicesForAccount, updateDevice } from "../db/devices";
import { setSessionDevice, type SessionRow } from "../db/sessions";

export type { DeviceRow };

export interface DeviceInput {
  apnsToken: string;
  platform: Platform;
  model: string;
  apnsEnv: ApnsEnv;
}

const APNS_TOKEN = /^[0-9a-f]{64,200}$/;
const MAX_MODEL_LENGTH = 100;

export function parseDeviceInput(body: unknown): { ok: true; value: DeviceInput } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, message: "Body must be a JSON object." };
  const b = body as Record<string, unknown>;
  const token = typeof b.apns_token === "string" ? b.apns_token.toLowerCase() : "";
  if (!APNS_TOKEN.test(token)) return { ok: false, message: "apns_token must be 64–200 hex characters." };
  if (b.platform !== "ios" && b.platform !== "macos") return { ok: false, message: "platform must be ios or macos." };
  if (b.apns_env !== "sandbox" && b.apns_env !== "production") return { ok: false, message: "apns_env must be sandbox or production." };
  const model = typeof b.model === "string" ? b.model.trim().slice(0, MAX_MODEL_LENGTH) : "";
  if (!model) return { ok: false, message: "model is required." };
  return { ok: true, value: { apnsToken: token, platform: b.platform, model, apnsEnv: b.apns_env } };
}

export function registerCurrentDevice(ctx: Ctx, session: SessionRow, input: DeviceInput): DeviceRow {
  if (session.kind !== "app") throw new Error("devices belong to app sessions only");
  return ctx.db.transaction(() => {
    const now = ctx.now();
    const current = session.device_id ? getDevice(ctx.db, session.device_id) : null;
    const holder = getDeviceByToken(ctx.db, input.apnsToken);
    // The token now belongs to this session. Any other row holding it is stale
    // (reinstall, or the phone signed into another account); deleting it also deletes its session.
    if (holder && holder.id !== current?.id) deleteDevice(ctx.db, holder.id);

    const fields = {
      platform: input.platform,
      model: input.model,
      apns_token: input.apnsToken,
      apns_env: input.apnsEnv,
      last_seen_at: now,
    };
    if (current && current.account_id === session.account_id) {
      updateDevice(ctx.db, current.id, fields);
      return { ...current, ...fields };
    }
    const row: DeviceRow = { id: newId("dev"), account_id: session.account_id, created_at: now, ...fields };
    insertDevice(ctx.db, row);
    setSessionDevice(ctx.db, session.id, row.id);
    return row;
  })();
}

export function listDevices(ctx: Ctx, accountId: string): DeviceRow[] {
  return listDevicesForAccount(ctx.db, accountId);
}
