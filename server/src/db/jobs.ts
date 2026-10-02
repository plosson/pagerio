import type { Database } from "bun:sqlite";

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
