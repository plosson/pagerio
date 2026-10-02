import { newId, randomToken } from "../auth/tokens";
import type { Config } from "../config";
import type { Ctx } from "../context";
import { listDevicesForAccount } from "../db/devices";
import { insertJob } from "../db/jobs";
import {
  countPagesSince,
  findRecentPageByIdempotencyKey,
  getPageById,
  insertPage,
  listPages,
  oldestPageSince,
  type PageRow,
  type PageSource,
} from "../db/pages";
import type { PageInput } from "./pageInput";

export type { PageRow, PageSource };

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const IDEMPOTENCY_WINDOW_MS = DAY_MS;
export const PAGE_RETENTION_MS = 30 * DAY_MS;

export const TEST_PAGE_INPUT: PageInput = {
  title: "Pocket Pager",
  message: "This is a test page. Your pager works.",
  details: null,
  url: null,
  group: null,
};

export type CreatePageResult =
  | { ok: true; page: PageRow; created: boolean }
  | { ok: false; code: "rate_limited"; retryAfterSeconds: number };

export function viewUrl(config: Config, publicId: string): string {
  return `${config.publicBaseUrl}/v/${publicId}`;
}

function retryAfter(ctx: Ctx, accountId: string, windowMs: number): number {
  const now = ctx.now();
  const oldest = oldestPageSince(ctx.db, accountId, now - windowMs) ?? now;
  return Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
}

export function createPage(
  ctx: Ctx,
  args: { accountId: string; input: PageInput; source: PageSource; idempotencyKey: string | null },
): CreatePageResult {
  return ctx.db.transaction((): CreatePageResult => {
    const now = ctx.now();
    if (args.idempotencyKey) {
      const existing = findRecentPageByIdempotencyKey(ctx.db, args.accountId, args.idempotencyKey, now - IDEMPOTENCY_WINDOW_MS);
      if (existing) return { ok: true, page: existing, created: false };
    }

    const { pagesPerMinute, pagesPerDay } = ctx.config.limits;
    if (countPagesSince(ctx.db, args.accountId, now - MINUTE_MS) >= pagesPerMinute) {
      return { ok: false, code: "rate_limited", retryAfterSeconds: retryAfter(ctx, args.accountId, MINUTE_MS) };
    }
    if (countPagesSince(ctx.db, args.accountId, now - DAY_MS) >= pagesPerDay) {
      return { ok: false, code: "rate_limited", retryAfterSeconds: retryAfter(ctx, args.accountId, DAY_MS) };
    }

    const page: PageRow = {
      id: newId("pg"),
      public_id: randomToken(),
      account_id: args.accountId,
      title: args.input.title,
      message: args.input.message,
      details: args.input.details,
      url: args.input.url,
      group_key: args.input.group,
      source: args.source,
      idempotency_key: args.idempotencyKey,
      created_at: now,
    };
    insertPage(ctx.db, page);
    for (const device of listDevicesForAccount(ctx.db, args.accountId)) {
      insertJob(ctx.db, {
        id: newId("job"),
        page_id: page.id,
        device_id: device.id,
        status: "pending",
        attempts: 0,
        next_attempt_at: now,
        apns_id: null,
        last_error: null,
        updated_at: now,
      });
    }
    return { ok: true, page, created: true };
  })();
}

export function listPagesForAccount(
  ctx: Ctx,
  accountId: string,
  opts: { beforeId: string | null; limit: number },
): { ok: true; pages: PageRow[]; nextBefore: string | null } | { ok: false; message: string } {
  let before: { created_at: number; id: string } | null = null;
  if (opts.beforeId) {
    const cursor = getPageById(ctx.db, opts.beforeId);
    if (!cursor || cursor.account_id !== accountId) return { ok: false, message: "Unknown cursor." };
    before = { created_at: cursor.created_at, id: cursor.id };
  }
  const pages = listPages(ctx.db, accountId, { since: ctx.now() - PAGE_RETENTION_MS, before, limit: opts.limit });
  return { ok: true, pages, nextBefore: pages.length === opts.limit ? pages.at(-1)!.id : null };
}
