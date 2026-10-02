import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");
const MIGRATION_FILE = /^(\d+)_.+\.sql$/;

export function openDatabase(path: string, migrationsDir: string = MIGRATIONS_DIR): Database {
  const db = new Database(path, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  migrate(db, migrationsDir);
  return db;
}

export function migrate(db: Database, dir: string): number[] {
  db.run("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const applied = new Set(
    db.query<{ version: number }, []>("SELECT version FROM schema_migrations").all().map((r) => r.version),
  );

  const migrations = readdirSync(dir)
    .map((file) => ({ file, match: MIGRATION_FILE.exec(file) }))
    .filter((m): m is { file: string; match: RegExpExecArray } => m.match !== null)
    .map(({ file, match }) => ({ file, version: Number(match[1]) }))
    .sort((a, b) => a.version - b.version);

  const seen = new Set<number>();
  for (const { version } of migrations) {
    if (seen.has(version)) throw new Error(`Duplicate migration version ${version}`);
    seen.add(version);
  }

  const ran: number[] = [];
  for (const { file, version } of migrations) {
    if (applied.has(version)) continue;
    const sql = readFileSync(join(dir, file), "utf8");
    db.transaction(() => {
      db.run(sql);
      db.query("INSERT INTO schema_migrations (version, applied_at) VALUES ($version, $at)").run({ version, at: Date.now() });
    })();
    ran.push(version);
  }
  return ran;
}
