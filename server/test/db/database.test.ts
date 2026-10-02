import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase } from "../../src/db/database";
import { tempDbPath } from "../helpers";

function tempMigrations(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "pagerio-mig-"));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

describe("openDatabase", () => {
  test("creates every table and turns on foreign keys", () => {
    const db = openDatabase(":memory:");
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
    expect(tables).toEqual(["accounts", "delivery_jobs", "devices", "pages", "schema_migrations", "sessions"]);
    expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
  });

  test("uses WAL on a file database and survives reopening without re-running migrations", () => {
    const path = tempDbPath();
    const first = openDatabase(path);
    expect(first.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    first.close();
    const second = openDatabase(path);
    expect(second.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM schema_migrations").get()?.n).toBe(1);
  });

  test("rejects rows that point at a missing account", () => {
    const db = openDatabase(":memory:");
    expect(() =>
      db.run("INSERT INTO devices (id, account_id, platform, model, apns_token, apns_env, created_at, last_seen_at) VALUES ('d', 'nope', 'ios', 'x', 'ab', 'sandbox', 0, 0)"),
    ).toThrow();
  });

  test("rejects values outside the allowed enums", () => {
    const db = openDatabase(":memory:");
    db.run("INSERT INTO accounts VALUES ('a', 'sub', 'e', 'h', 'enc', 0)");
    expect(() =>
      db.run("INSERT INTO devices (id, account_id, platform, model, apns_token, apns_env, created_at, last_seen_at) VALUES ('d', 'a', 'android', 'x', 'ab', 'sandbox', 0, 0)"),
    ).toThrow();
  });
});

describe("migrate", () => {
  test("is idempotent", () => {
    const db = openDatabase(":memory:");
    expect(migrate(db, join(import.meta.dir, "../../migrations"))).toEqual([]);
  });

  test("rolls back a failing migration and does not record it", () => {
    const dir = tempMigrations({
      "001_ok.sql": "CREATE TABLE ok (id TEXT);",
      "002_bad.sql": "CREATE TABLE half (id TEXT); THIS IS NOT SQL;",
    });
    const db = openDatabase(":memory:", tempMigrations({}));
    expect(() => migrate(db, dir)).toThrow();
    const versions = db.query<{ version: number }, []>("SELECT version FROM schema_migrations").all().map((r) => r.version);
    expect(versions).toEqual([1]);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'half'").get()).toBeNull();
  });

  test("refuses duplicate version numbers", () => {
    const dir = tempMigrations({ "001_a.sql": "SELECT 1;", "001_b.sql": "SELECT 1;" });
    const db = openDatabase(":memory:", tempMigrations({}));
    expect(() => migrate(db, dir)).toThrow("Duplicate migration version 1");
  });

  test("ignores files that are not numbered .sql migrations", () => {
    const dir = tempMigrations({ "README.md": "hi", "notes.sql": "garbage", "001_a.sql": "CREATE TABLE a (id TEXT);" });
    const db = openDatabase(":memory:", tempMigrations({}));
    expect(migrate(db, dir)).toEqual([1]);
  });
});
