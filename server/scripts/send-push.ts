// Phase 1 helper: send one notification to a raw device token.
// Usage: bun run send-push --token <hex> [--platform ios|macos] [--env sandbox|production] [--title T] [--message M]
// Reads APNS_KEY_P8, APNS_KEY_ID, APNS_TEAM_ID (and optional APNS_TOPIC_*) from server/.env.
import { parseArgs } from "node:util";
import { loadApnsConfig, type ApnsEnv, type Platform } from "../src/config";
import { createApnsSender } from "../src/delivery/apns";

const { values } = parseArgs({
  options: {
    token: { type: "string" },
    platform: { type: "string", default: "ios" },
    env: { type: "string", default: "sandbox" },
    title: { type: "string" },
    message: { type: "string", default: "You've been paged." },
  },
});

if (!values.token) throw new Error("--token is required");
if (values.platform !== "ios" && values.platform !== "macos") throw new Error("--platform must be ios or macos");
if (values.env !== "sandbox" && values.env !== "production") throw new Error("--env must be sandbox or production");

const sender = createApnsSender(loadApnsConfig());
const result = await sender.send(
  { token: values.token, platform: values.platform as Platform, env: values.env as ApnsEnv },
  {
    title: values.title ?? null,
    body: values.message!,
    threadId: "pages",
    publicId: null,
    viewUrl: null,
    url: null,
    expiresAtSeconds: Math.floor(Date.now() / 1000) + 3600,
  },
);
console.log(JSON.stringify(result));
sender.close();
process.exit(result.kind === "ok" ? 0 : 1);
