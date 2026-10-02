import type { Database } from "bun:sqlite";
import type { Config } from "./config";

export interface Ctx {
  db: Database;
  config: Config;
  now: () => number;
}
