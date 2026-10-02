import type { Database } from "bun:sqlite";

export type PageSource = "trigger" | "test";

export type PageRow = {
  id: string;
  public_id: string;
  account_id: string;
  title: string | null;
  message: string;
  details: string | null;
  url: string | null;
  group_key: string | null;
  source: PageSource;
  idempotency_key: string | null;
  created_at: number;
};

export function insertPage(db: Database, row: PageRow): void {
  db.query(
    `INSERT INTO pages (id, public_id, account_id, title, message, details, url, group_key, source, idempotency_key, created_at)
     VALUES ($id, $public_id, $account_id, $title, $message, $details, $url, $group_key, $source, $idempotency_key, $created_at)`,
  ).run(row);
}

export function getPageById(db: Database, id: string): PageRow | null {
  return db.query<PageRow, { id: string }>("SELECT * FROM pages WHERE id = $id").get({ id }) ?? null;
}

export function getPageByPublicId(db: Database, publicId: string): PageRow | null {
  return db.query<PageRow, { publicId: string }>("SELECT * FROM pages WHERE public_id = $publicId").get({ publicId }) ?? null;
}

export function findRecentPageByIdempotencyKey(db: Database, accountId: string, key: string, since: number): PageRow | null {
  return (
    db
      .query<PageRow, { accountId: string; key: string; since: number }>(
        `SELECT * FROM pages WHERE account_id = $accountId AND idempotency_key = $key AND created_at > $since
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get({ accountId, key, since }) ?? null
  );
}

export function countPagesSince(db: Database, accountId: string, since: number): number {
  return db
    .query<{ n: number }, { accountId: string; since: number }>(
      "SELECT COUNT(*) AS n FROM pages WHERE account_id = $accountId AND created_at > $since",
    )
    .get({ accountId, since })!.n;
}

export function oldestPageSince(db: Database, accountId: string, since: number): number | null {
  return (
    db
      .query<{ at: number | null }, { accountId: string; since: number }>(
        "SELECT MIN(created_at) AS at FROM pages WHERE account_id = $accountId AND created_at > $since",
      )
      .get({ accountId, since })?.at ?? null
  );
}

/** Newest first. `before` is the (created_at, id) of the last page already seen. */
export function listPages(
  db: Database,
  accountId: string,
  opts: { since: number; before: { created_at: number; id: string } | null; limit: number },
): PageRow[] {
  if (opts.before) {
    return db
      .query<PageRow, { accountId: string; since: number; beforeAt: number; beforeId: string; limit: number }>(
        `SELECT * FROM pages WHERE account_id = $accountId AND created_at > $since
           AND (created_at < $beforeAt OR (created_at = $beforeAt AND id < $beforeId))
         ORDER BY created_at DESC, id DESC LIMIT $limit`,
      )
      .all({ accountId, since: opts.since, beforeAt: opts.before.created_at, beforeId: opts.before.id, limit: opts.limit });
  }
  return db
    .query<PageRow, { accountId: string; since: number; limit: number }>(
      `SELECT * FROM pages WHERE account_id = $accountId AND created_at > $since
       ORDER BY created_at DESC, id DESC LIMIT $limit`,
    )
    .all({ accountId, since: opts.since, limit: opts.limit });
}
