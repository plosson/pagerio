import { loadConfig } from "./config";
import { startServer } from "./server";

const running = startServer(loadConfig());

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    await running.stop();
    process.exit(0);
  });
}
