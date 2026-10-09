import type { Database } from "bun:sqlite";
import type { ApnsEnv, Platform } from "../config";

export type JobStatus = "pending" | "sending" | "submitted" | "failed";

export type JobRow = {
  id: string;
  page_id: string;
  device_id: string | null;
  status: JobStatus;
  attempts: number;
  next_attempt_at: number;
  apns_id: string | null;
  last_error: string | null;
  updated_at: number;
};

export function insertJob(db: Database, row: JobRow): void {
  db.query(
    `INSERT INTO delivery_jobs (id, page_id, device_id, status, attempts, next_attempt_at, apns_id, last_error, updated_at)
     VALUES ($id, $page_id, $device_id, $status, $attempts, $next_attempt_at, $apns_id, $last_error, $updated_at)`,
  ).run(row);
}

export type DeliveryContext = {
  job_id: string;
  attempts: number;
  device_id: string | null;
  apns_token: string | null;
  apns_env: ApnsEnv | null;
  platform: Platform | null;
  title: string | null;
  message: string;
  group_key: string | null;
  public_id: string;
  url: string | null;
  page_created_at: number;
};

/** Atomically moves due jobs to 'sending' so no job is sent twice in parallel. */
export function claimDueJobs(db: Database, now: number, limit: number): JobRow[] {
  return db
    .query<JobRow, { now: number; limit: number }>(
      `UPDATE delivery_jobs SET status = 'sending', updated_at = $now
       WHERE id IN (
         SELECT id FROM delivery_jobs WHERE status = 'pending' AND next_attempt_at <= $now
         ORDER BY next_attempt_at, id LIMIT $limit
       )
       RETURNING *`,
    )
    .all({ now, limit });
}

export function getDeliveryContext(db: Database, jobId: string): DeliveryContext | null {
  return (
    db
      .query<DeliveryContext, { jobId: string }>(
        `SELECT j.id AS job_id, j.attempts, j.device_id, d.apns_token, d.apns_env, d.platform,
                p.title, p.message, p.group_key, p.public_id, p.url, p.created_at AS page_created_at
         FROM delivery_jobs j
         JOIN pages p ON p.id = j.page_id
         LEFT JOIN devices d ON d.id = j.device_id
         WHERE j.id = $jobId`,
      )
      .get({ jobId }) ?? null
  );
}

export function markSubmitted(db: Database, id: string, apnsId: string, at: number): void {
  db.query("UPDATE delivery_jobs SET status = 'submitted', apns_id = $apnsId, last_error = NULL, updated_at = $at WHERE id = $id AND status = 'sending'").run({
    id,
    apnsId,
    at,
  });
}

export function markFailed(db: Database, id: string, reason: string, at: number): void {
  db.query("UPDATE delivery_jobs SET status = 'failed', last_error = $reason, updated_at = $at WHERE id = $id AND status = 'sending'").run({ id, reason, at });
}

export function scheduleRetry(db: Database, id: string, attempts: number, nextAt: number, reason: string, at: number): void {
  db.query(
    `UPDATE delivery_jobs SET status = 'pending', attempts = $attempts, next_attempt_at = $nextAt,
       last_error = $reason, updated_at = $at WHERE id = $id AND status = 'sending'`,
  ).run({ id, attempts, nextAt, reason, at });
}

/** On boot: jobs a previous process was sending are sent again (at-least-once). */
export function resetSendingJobs(db: Database, at: number): number {
  return db.query("UPDATE delivery_jobs SET status = 'pending', updated_at = $at WHERE status = 'sending'").run({ at }).changes;
}

/** Earliest moment an unfinished job became due, or null when nothing is overdue. */
export function oldestOverdueJobAt(db: Database, now: number): number | null {
  return (
    db
      .query<{ at: number | null }, { now: number }>(
        `SELECT MIN(CASE WHEN status = 'pending' THEN next_attempt_at ELSE updated_at END) AS at
         FROM delivery_jobs
         WHERE (status = 'pending' AND next_attempt_at <= $now) OR status = 'sending'`,
      )
      .get({ now })?.at ?? null
  );
}

/** After an unexpected error, hands a claimed job back to the queue so it is retried shortly. */
export function releaseJob(db: Database, id: string, at: number): void {
  db.query("UPDATE delivery_jobs SET status = 'pending', next_attempt_at = $at + 5000, updated_at = $at WHERE id = $id AND status = 'sending'").run({ id, at });
}

export type DeliveryCounts = { sent: number; sending: number; failed: number };

/** Per page: how many device jobs APNs accepted, are still queued or in flight, and gave up. */
export function deliveryCountsForPages(db: Database, pageIds: string[]): Map<string, DeliveryCounts> {
  const rows = db
    .query<DeliveryCounts & { page_id: string }, { ids: string }>(
      `SELECT page_id,
              SUM(status = 'submitted') AS sent,
              SUM(status IN ('pending', 'sending')) AS sending,
              SUM(status = 'failed') AS failed
       FROM delivery_jobs WHERE page_id IN (SELECT value FROM json_each($ids))
       GROUP BY page_id`,
    )
    .all({ ids: JSON.stringify(pageIds) });
  return new Map(rows.map(({ page_id, ...counts }) => [page_id, counts]));
}

export type LastDelivery = { status: JobStatus; last_error: string | null };

/** Per device of the account: the status of its most recent delivery job. */
export function lastDeliveryByDevice(db: Database, accountId: string): Map<string, LastDelivery> {
  const rows = db
    .query<LastDelivery & { device_id: string }, { accountId: string }>(
      `SELECT j.device_id, j.status, j.last_error
       FROM devices d
       JOIN delivery_jobs j ON j.id = (
         SELECT id FROM delivery_jobs WHERE device_id = d.id ORDER BY updated_at DESC, id DESC LIMIT 1
       )
       WHERE d.account_id = $accountId`,
    )
    .all({ accountId });
  return new Map(rows.map(({ device_id, ...last }) => [device_id, last]));
}
