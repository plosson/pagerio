import type { Database } from "bun:sqlite";
import { FixedWindowLimiter } from "./api/ipLimiter";
import { createApp } from "./app";
import { createGoogleVerifier, type GoogleVerifier } from "./auth/google";
import { createGoogleOAuthClient, type GoogleOAuthClient } from "./auth/googleOAuth";
import type { Config } from "./config";
import { openDatabase } from "./db/database";
import { type ApnsSender, createApnsSender } from "./delivery/apns";
import { DeliveryWorker } from "./delivery/worker";
import { createLogger, type Logger } from "./logging";

const MAX_REQUEST_BODY_BYTES = 64 * 1024;

export interface RunningServer {
  url: string;
  db: Database;
  stop(): Promise<void>;
}

export function startServer(
  config: Config,
  overrides: {
    sender?: ApnsSender;
    google?: GoogleVerifier;
    googleOAuth?: GoogleOAuthClient;
    logger?: Logger;
    shutdownTimeoutMs?: number;
  } = {},
): RunningServer {
  const now = Date.now;
  const db = openDatabase(config.databasePath);
  const logger = overrides.logger ?? createLogger();
  const sender = overrides.sender ?? createApnsSender(config.apns);
  const worker = new DeliveryWorker({ db, config, now, sender, logger });
  const app = createApp({
    db,
    config,
    now,
    logger,
    worker,
    ipLimiter: new FixedWindowLimiter(config.limits.triggerRequestsPerIpPerMinute, 60_000, now),
    google:
      overrides.google ??
      createGoogleVerifier([config.google.webClientId, config.google.iosClientId, config.google.macosClientId]),
    googleOAuth:
      overrides.googleOAuth ??
      createGoogleOAuthClient({
        clientId: config.google.webClientId,
        clientSecret: config.google.webClientSecret,
        redirectUri: `${config.publicBaseUrl}/auth/google/callback`,
      }),
  });

  worker.start();
  const server = Bun.serve({ port: config.port, fetch: app.fetch, maxRequestBodySize: MAX_REQUEST_BODY_BYTES });
  logger.info("server_started", { port: server.port ?? 0 });

  const shutdownTimeoutMs = overrides.shutdownTimeoutMs ?? 5_000;
  let stopping: Promise<void> | null = null;
  const shutdown = async (): Promise<void> => {
    // Without `true`, in-flight requests finish; wait for them, then force-close.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve(server.stop()),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, shutdownTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    await server.stop(true);
    await worker.stop(shutdownTimeoutMs);
    sender.close();
    db.close();
  };

  return {
    url: `http://localhost:${server.port}`,
    db,
    stop() {
      stopping ??= shutdown();
      return stopping;
    },
  };
}
