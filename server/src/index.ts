import { loadConfig } from "./config";
import { startServer } from "./server";

const running = startServer(loadConfig());
let shuttingDown = false;

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await running.stop();
      process.exit(0);
    } catch (err) {
      console.error("shutdown_failed", err instanceof Error ? err.name : "unknown");
      process.exit(1);
    }
  });
}
