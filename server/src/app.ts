import { Hono } from "hono";
import type { FixedWindowLimiter } from "./api/ipLimiter";
import { errorJson } from "./api/responses";
import { appApiRoutes } from "./api/appApi";
import { triggerRoutes } from "./api/trigger";
import type { GoogleVerifier } from "./auth/google";
import type { GoogleOAuthClient } from "./auth/googleOAuth";
import type { Ctx } from "./context";
import { oldestOverdueJobAt } from "./db/jobs";
import { type Logger, requestLogger } from "./logging";

export interface AppDeps extends Ctx {
  logger: Logger;
  worker: { wake(): void };
  ipLimiter: FixedWindowLimiter;
  google: GoogleVerifier;
  googleOAuth: GoogleOAuthClient;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.use("*", requestLogger(deps.logger));
  app.onError((err, c) => {
    deps.logger.error("unhandled_error", { name: err.name });
    return errorJson(c, 500, "internal", "Something went wrong. Try again.");
  });
  app.notFound((c) => errorJson(c, 404, "not_found", "Not found."));

  app.get("/healthz", (c) => {
    const now = deps.now();
    const oldest = oldestOverdueJobAt(deps.db, now);
    return c.json({ ok: true, oldest_pending_ms: oldest === null ? 0 : now - oldest });
  });
  app.route("/", triggerRoutes(deps));
  app.route("/api", appApiRoutes(deps));
  return app;
}
