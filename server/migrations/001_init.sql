CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  trigger_token_hash TEXT NOT NULL UNIQUE,
  trigger_token_enc TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'macos')),
  model TEXT NOT NULL,
  apns_token TEXT NOT NULL UNIQUE,
  apns_env TEXT NOT NULL CHECK (apns_env IN ('sandbox', 'production')),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX devices_account ON devices(account_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('web', 'app')),
  device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX sessions_account ON sessions(account_id);

CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  title TEXT,
  message TEXT NOT NULL,
  details TEXT,
  url TEXT,
  group_key TEXT,
  source TEXT NOT NULL CHECK (source IN ('trigger', 'test')),
  idempotency_key TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX pages_account_created ON pages(account_id, created_at DESC, id DESC);
CREATE INDEX pages_account_idempotency ON pages(account_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE delivery_jobs (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'submitted', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  apns_id TEXT,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX delivery_jobs_due ON delivery_jobs(status, next_attempt_at);
CREATE INDEX delivery_jobs_page ON delivery_jobs(page_id);
