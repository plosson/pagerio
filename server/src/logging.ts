import type { MiddlewareHandler } from "hono";

export type LogFields = Record<string, string | number | boolean | null>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export function createLogger(sink: (line: string) => void = (line) => console.log(line)): Logger {
  const write = (level: "info" | "error", event: string, fields: LogFields = {}) =>
    sink(JSON.stringify({ time: new Date().toISOString(), level, event, ...fields }));
  return {
    info: (event, fields) => write("info", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}

/** Trigger tokens (/p/…) and public page ids (/v/…) are secrets: never log them. */
export function redactPath(path: string): string {
  return path.replace(/^\/(p|v)\/[^/]+/, "/$1/***");
}

export function requestLogger(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const started = performance.now();
    await next();
    logger.info("http", {
      method: c.req.method,
      path: redactPath(c.req.path),
      status: c.res.status,
      ms: Math.round(performance.now() - started),
    });
  };
}
