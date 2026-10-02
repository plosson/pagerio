import type { Ctx } from "../context";
import { deleteDevice } from "../db/devices";
import {
  claimDueJobs,
  getDeliveryContext,
  markFailed,
  markSubmitted,
  resetSendingJobs,
  scheduleRetry,
} from "../db/jobs";
import type { Logger } from "../logging";
import { viewUrl } from "../services/pages";
import type { ApnsResult, ApnsSender } from "./apns";

export const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000] as const;
export const PAGE_TTL_SECONDS = 3600;

export type WorkerDeps = Ctx & { sender: ApnsSender; logger: Logger };
export interface WorkerOptions {
  intervalMs?: number;
  batchSize?: number;
  maxInFlight?: number;
}

export class DeliveryWorker {
  private readonly inFlight = new Set<Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly deps: WorkerDeps,
    private readonly options: WorkerOptions = {},
  ) {}

  recover(): number {
    return resetSendingJobs(this.deps.db, this.deps.now());
  }

  /** Claims due jobs and starts sending them. Returns how many were claimed. */
  tick(): number {
    const capacity = (this.options.maxInFlight ?? 100) - this.inFlight.size;
    if (capacity <= 0) return 0;
    const jobs = claimDueJobs(this.deps.db, this.deps.now(), Math.min(capacity, this.options.batchSize ?? 50));
    for (const job of jobs) {
      const running: Promise<void> = this.deliver(job.id)
        .catch((err: unknown) => {
          this.deps.logger.error("delivery_crashed", { name: err instanceof Error ? err.name : "unknown" });
        })
        .finally(() => this.inFlight.delete(running));
      this.inFlight.add(running);
    }
    return jobs.length;
  }

  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  wake(): void {
    queueMicrotask(() => this.tick());
  }

  start(): void {
    const recovered = this.recover();
    if (recovered > 0) this.deps.logger.info("delivery_recovered", { jobs: recovered });
    this.timer = setInterval(() => this.tick(), this.options.intervalMs ?? 500);
    this.tick();
  }

  async stop(timeoutMs = 5_000): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.race([this.idle(), new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
  }

  private async deliver(jobId: string): Promise<void> {
    const { db, now, sender, config, logger } = this.deps;
    const job = getDeliveryContext(db, jobId);
    if (!job) return; // page or account deleted since the claim
    if (!job.apns_token || !job.apns_env || !job.platform || !job.device_id) {
      markFailed(db, jobId, "device_removed", now());
      return;
    }
    const expiresAtSeconds = Math.floor(job.page_created_at / 1000) + PAGE_TTL_SECONDS;
    if (now() >= expiresAtSeconds * 1000) {
      markFailed(db, jobId, "expired", now());
      logger.info("delivery", { outcome: "expired", platform: job.platform });
      return;
    }

    let result: ApnsResult;
    try {
      result = await sender.send(
        { token: job.apns_token, env: job.apns_env, platform: job.platform },
        {
          title: job.title,
          body: job.message,
          threadId: job.group_key ?? "pages",
          publicId: job.public_id,
          viewUrl: viewUrl(config, job.public_id),
          url: job.url,
          expiresAtSeconds,
        },
      );
    } catch {
      result = { kind: "retry", reason: "sender_exception" };
    }

    const at = now();
    const deviceId = job.device_id;
    switch (result.kind) {
      case "ok":
        markSubmitted(db, jobId, result.apnsId, at);
        break;
      case "invalid-token":
        db.transaction(() => {
          markFailed(db, jobId, result.reason, at);
          deleteDevice(db, deviceId);
        })();
        break;
      case "retry": {
        const attempts = job.attempts + 1;
        const delay = RETRY_DELAYS_MS[attempts - 1];
        if (delay === undefined) markFailed(db, jobId, result.reason, at);
        else scheduleRetry(db, jobId, attempts, at + delay, result.reason, at);
        break;
      }
      case "fail":
        markFailed(db, jobId, result.reason, at);
        break;
    }
    logger.info("delivery", { outcome: result.kind, platform: job.platform });
  }
}
