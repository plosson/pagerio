# Pocket Pager — Design

Date: 2026-10-02
Status: Draft for review
Working name: Pocket Pager (repo: `pagerio`, host: `pagerio.chuut.com`)

## 1. Intent

A personal pager. You sign in on the website, get a private URL, and call it from scripts, deployments or AI agents. Every iPhone and Mac you have signed into sounds with the message.

- **Audience:** individuals who run automations and want to be interrupted when something needs them. Team incident management is out of scope.
- **First release:** multi-user from day one, distributed through TestFlight only (iOS and macOS). No App Store release.
- **Builder:** one developer.
- **Success:** a task finishes on your computer, and your iPhone and Mac both sound with the message.

### Decisions taken during brainstorming

| Topic | Decision |
|---|---|
| Users | Multi-user from day one. |
| Sign-in | Google only. Sign in with Apple is added later only if TestFlight review requires it. |
| Hosting | One container deployed with siteio. Bun + Hono + SQLite on a siteio volume. |
| Acknowledgment | Dropped. No "Got it", no pending state, no repeats, no cross-device sync. Pages are events in a shared history. |
| Account hub | The website. The apps are receivers plus a recent-pages list. |
| Page content | Notification shows title and message. Each page has a public, unguessable web page (`/v/:public_id`) with the full content, including Markdown `details`. |
| Opening a page | Apps open `/v/:public_id` in the system browser. No in-app web view, no native page view. |
| Apple code layout | Shared Swift package (PagerKit) plus an iOS target and a macOS target, generated with XcodeGen. |

## 2. Scope

### In the MVP

- Google sign-in on the web, iPhone and Mac. The first sign-in anywhere creates the account.
- One personal trigger URL per account, shown on the web dashboard with copy and regenerate actions.
- Trigger by POST with an empty body, plain text or JSON.
- Every page goes to all of the account's registered devices through APNs, with the pager sound and the Time Sensitive interruption level.
- A public page view for every page.
- 30-day history, visible on the web and in the apps.
- Web dashboard: link, copy, curl example, test, recent pages, devices, link regeneration, account deletion, sign-out.
- iOS app: sign-in, notification status, Test my pager, recent pages, sign-out, open dashboard.
- macOS menu-bar app: the same content in a menu-bar panel, plus Launch at login.
- Rate limits, `Idempotency-Key`, hashed tokens, retention cleanup.

### Out of scope

Acknowledgment, repeats, Sign in with Apple, Android, teams, multiple pager URLs per account, GET triggering, attachments and images, per-page icons, SMS and phone calls, billing, off-site backups.

## 3. Architecture

```text
curl ──POST /p/:token──▶ ┌──────────── one container (siteio) ────────────┐
browser ──/, /v/:id ───▶ │  Hono (web + API) ──▶ SQLite ◀── worker loop   │
apps ──/api/* (bearer)─▶ │     pages + delivery jobs          │           │
                         └────────────────────────────────────┼───────────┘
                                                              ▼
                                                    APNs (HTTP/2, .p8 key)
                                                       ↙          ↘
                                                   iPhone          Mac
```

### Repository layout

```text
pagerio/
├── server/                 Bun + Hono + bun:sqlite
│   ├── src/
│   │   ├── db/             all SQL, migrations, data access
│   │   ├── services/       createPage, regenerateTriggerToken, removeDevice, ...
│   │   ├── delivery/       worker loop, APNs sender
│   │   ├── auth/           Google verification, sessions, CSRF
│   │   ├── web/            Hono JSX pages (dashboard, /v/)
│   │   └── api/            /p/:token and /api/* routes
│   ├── migrations/         numbered .sql files
│   └── Dockerfile
└── apple/
    ├── project.yml         XcodeGen
    ├── PagerKit/           Swift package
    ├── iOSApp/
    └── MacApp/
```

The web routes and the app API both call the same service functions. No business logic lives in route handlers.

## 4. Data model (SQLite)

| Table | Fields | Notes |
|---|---|---|
| `accounts` | `id`, `google_sub` (unique), `email`, `trigger_token_hash` (unique), `trigger_token_enc`, `created_at` | One trigger URL per account. |
| `sessions` | `id`, `account_id`, `kind` (`web`/`app`), `device_id` (nullable), `token_hash` (unique), `created_at`, `last_used_at` | Opaque tokens, so revocation is immediate. |
| `devices` | `id`, `account_id`, `platform` (`ios`/`macos`), `model`, `apns_token` (unique), `apns_env` (`sandbox`/`production`), `created_at`, `last_seen_at` | |
| `pages` | `id`, `public_id` (unique), `account_id`, `title`, `message`, `details`, `url`, `group_key`, `source` (`trigger`/`test`), `idempotency_key`, `created_at` | Unique on (`account_id`, `idempotency_key`). |
| `delivery_jobs` | `id`, `page_id`, `device_id`, `status` (`pending`/`sending`/`submitted`/`failed`), `attempts`, `next_attempt_at`, `apns_id`, `last_error`, `updated_at` | `submitted` means APNs accepted it. It is never shown as "delivered". |

The trigger token, session tokens and `public_id` values are 32 random bytes, base64url-encoded (43 characters).

- Trigger and session tokens are stored only as SHA-256 hashes for lookup.
- The trigger token is also stored AES-GCM-encrypted with `TOKEN_ENC_KEY`, so the dashboard can show the URL on every visit.
- `public_id` values are stored in plain form. Each one grants read access to exactly one page.

## 5. Sign-in

- **Web:** the Google OAuth authorization-code flow (`/auth/google` → Google → `/auth/google/callback`). The server exchanges the code, verifies the ID token and sets a session cookie (`HttpOnly`, `Secure`, `SameSite=Lax`).
- **Apps:** the native Google Sign-In SDK returns an ID token. The app sends it to `POST /api/auth/google` and receives a bearer session token, stored in the Keychain.
- **Account matching:** both paths find or create the account by Google `sub`. The server accepts ID tokens for three client IDs: web, iOS and macOS.
- **Future providers:** adding Sign in with Apple means adding one more ID-token verifier. Sessions don't depend on the provider.

## 6. HTTP interface

### Trigger

`POST /p/:token`

| Input | Result |
|---|---|
| Empty body | Message "You've been paged." |
| Non-JSON body | The body (trimmed) is the message. |
| `Content-Type: application/json` | Fields below. Unknown fields are ignored. |

| Field | Limit | Shown in |
|---|---|---|
| `title` | 100 chars | Notification, page view |
| `message` | 1,000 chars, plain text | Notification (cut off when long), page view |
| `details` | 10,000 chars, Markdown | Page view only |
| `url` | `http` or `https` only | Notification **Open link** action, page view button |
| `group` | 50 chars | Notification grouping (`thread-id`) |

- The maximum body size is 16 KB.
- An optional `Idempotency-Key` header (max 200 chars) makes retries within 24 hours return the original page instead of creating a new one.

**Responses:**

| Status | Meaning |
|---|---|
| `202 {id, status:"accepted", view_url}` | The page and its delivery jobs are committed. |
| `400` | Invalid input. |
| `404` | Unknown token. The response is identical whether the token never existed or was regenerated. |
| `413` | Body over 16 KB. |
| `429` | Rate-limited, with `Retry-After`. |
| `500` | Service failure. |

Errors use the shape `{error:{code,message}}`.

**Rate limits:**
- Per account: 10 pages per minute and 100 per day, counted from the `pages` table so they survive restarts. Both values are configurable.
- Per IP: an in-memory limit, which resets on restart.

### Public page view

`GET /v/:public_id` renders the page as HTML: title, time, message, `details` and an **Open link** button. It requires no sign-in.

- Markdown is rendered with raw HTML disabled, and the output is sanitized.
- The response sends `X-Robots-Tag: noindex` and `Referrer-Policy: no-referrer`.
- It returns `404` once the page is past retention or the account is deleted.

### Web dashboard (cookie session)

| Route | Purpose |
|---|---|
| `/` | Signed out: what Pocket Pager is, plus sign-in. Signed in: pager link, copy button, curl example, Test my pager, recent pages (each linking to `/v/`), and a delivery summary ("Sent to 2 devices", "1 failed"). |
| `/devices` | List and remove devices. Removing a device also revokes its session. |
| `/settings` | Regenerate link, delete account, sign out. |

- Pages are server-rendered with Hono JSX.
- Forms carry CSRF tokens.
- The Content Security Policy forbids inline scripts.

### App API (bearer session)

| Endpoint | Purpose |
|---|---|
| `POST /api/auth/google` | Exchange a Google ID token for a session. |
| `POST /api/auth/logout` | Revoke the session. |
| `PUT /api/devices/current` | Register or refresh this device's APNs token, platform, model and environment. |
| `GET /api/pages?before=&limit=` | History, newest first, cursor-paginated (default 50). |
| `POST /api/test` | Send a test page to all devices. |

### Operations

`GET /healthz` checks the database and reports the age of the oldest pending delivery job.

## 7. Delivery

### Creating a page

`createPage` runs in a single SQLite transaction:

1. Check the rate limits and the idempotency key.
2. Insert the page with a new `public_id`.
3. Insert one `delivery_jobs` row per registered device (`pending`, `next_attempt_at = now`).
4. Commit. The caller returns `202`, then signals the worker.

An account with no devices still gets `202`. The page appears in history, and the dashboard shows "no devices yet".

### Worker loop

- Runs in the same process, started at boot.
- Wakes every 500 ms, and immediately when signalled.
- Claims due jobs by setting `status = sending` inside a transaction.
- On boot, jobs left in `sending` revert to `pending`. A crash mid-send can therefore cause a duplicate notification, never a lost one (at-least-once delivery).
- Sends jobs concurrently, so one slow APNs response doesn't block the others.
- Uses a JWT signed with the `.p8` key, refreshed every 50 minutes, over HTTP/2.
- Chooses the APNs host from `apns_env`, and the `apns-topic` from the device platform's bundle ID.

### APNs outcomes

| Response | Action |
|---|---|
| `200` | `submitted`, store `apns-id` |
| `410`, or `400 BadDeviceToken` | `failed`, delete the device and its session |
| `429`, `5xx`, network error or timeout | Retry after 5 s, 30 s, 2 min and 10 min, then mark `failed` |
| Other `4xx` | `failed`, store the reason |

### Payload

```json
{
  "aps": {
    "alert": { "title": "Build finished", "body": "Ready for your review." },
    "sound": "pager.caf",
    "interruption-level": "time-sensitive",
    "thread-id": "ci",
    "category": "PAGE_WITH_LINK"
  },
  "public_id": "…",
  "view_url": "https://pagerio.chuut.com/v/…",
  "url": "https://…"
}
```

- Fields without a value are omitted.
- `thread-id` defaults to `pages`.
- `apns-expiration` is one hour after creation.
- `category` is `PAGE_WITH_LINK` only when `url` is present. That category carries the **Open link** action; otherwise `category` is omitted.

## 8. Apple apps

### PagerKit (shared Swift package)

| Unit | Responsibility |
|---|---|
| `APIClient` | Calls `/api/*` with the bearer token. On `401` it signs out locally. |
| `AuthService` | Runs Google Sign-In, exchanges the ID token, and stores the session in the Keychain. |
| `DeviceRegistrar` | Requests notification permission and registers the APNs token on every launch and token change. Debug builds report `sandbox`; Release builds report `production`. |
| `PagesStore` | Holds the latest 50 pages. Refreshes on launch, when the app comes to the front, and when a notification arrives while the app is open. |
| `NotificationHandler` | Registers the notification categories. A tap opens `view_url`; the **Open link** action opens `url`. Both open in the system browser. A malformed payload opens the app instead of crashing. |

### iOS app

- **Sign-in screen:** name, one sentence and **Sign in with Google**.
- **Home screen:**
  - A status line: "Ready" or "Notifications are off", with a button to open Settings.
  - A **Test my pager** button.
  - The recent pages list. Tapping a page opens `view_url` in Safari.
  - A menu with **Sign out** and **Open dashboard**.

### macOS app

- Menu-bar only, with no Dock icon (`LSUIElement`).
- The panel contains the status line, **Test my pager**, recent pages, **Open dashboard**, **Launch at login** and **Quit**.
- Google sign-in opens a small window that closes once sign-in completes.
- Launch at login (system login-item API) is on by default after sign-in.

### Assets and distribution

- `pager.caf` is bundled in both apps. Phase 1 uses a placeholder; phase 3 replaces it.
- Devices are labelled by platform, model and date added, because iOS no longer exposes user-chosen device names.
- Distribution needs one Apple Developer account, one App ID per platform with push enabled, one APNs `.p8` key, and TestFlight for iOS and macOS.

## 9. Security, privacy and operations

- **Secrets** (set with `siteio apps set --secret`): `TOKEN_ENC_KEY`, `APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `GOOGLE_CLIENT_ID_WEB`, `GOOGLE_CLIENT_SECRET_WEB`, `GOOGLE_CLIENT_ID_IOS`, `GOOGLE_CLIENT_ID_MACOS`, `SESSION_COOKIE_SECRET`.
- **Logging:**
  - Request paths are redacted to `/p/***` and `/v/***`.
  - Message content is never logged.
  - Logs record counts and outcomes only.
- **Retention:** an hourly job deletes pages older than 30 days, with their delivery jobs. Sessions unused for 90 days expire.
- **Regenerating the link** replaces the hash and the encrypted copy in one statement. The old URL returns `404` immediately.
- **Account deletion:**
  - One transaction removes the account, its sessions, devices, pages and jobs.
  - The trigger URL and every `/v/` link stop working immediately.
- **Database:**
  - `bun:sqlite` in WAL mode at `/data/pagerio.db` on a siteio volume.
  - Migrations are applied at boot.
  - All SQL lives in `server/src/db/`.
- **Backups:** a nightly `VACUUM INTO /data/backups/` keeps 7 copies on the same volume. This protects against mistakes, not against losing the server.
- **Lock-screen privacy:** follows the user's system settings. No end-to-end encryption is claimed.
- **Interruptions:** Apple controls delivery and interruption. Time Sensitive can be blocked by the user, and Critical Alerts are not used. The product never promises guaranteed interruption.

## 10. Testing

Tests target failure cases first.

**Server (`bun test`):**
- **Test seams:** the APNs sender and the Google verifier are interfaces, replaced by fakes in tests. Each test uses a fresh SQLite file.
- **Trigger input:**
  - Body over 16 KB; field over its limit.
  - Invalid JSON with a JSON content type.
  - `javascript:` and `file:` URLs.
  - Wrong field types.
  - Unknown fields (ignored).
  - Non-UTF-8 bytes.
- **Tokens:**
  - Old token after regeneration.
  - Token from a deleted account.
  - Truncated or altered tokens.
  - Identical `404` responses for unknown and regenerated tokens.
- **Idempotency:**
  - Same key twice, including concurrently: one page.
  - Same key on two accounts: two pages.
  - Same key after 24 hours: a new page.
- **Rate limits:**
  - The 11th request in a minute gets `429` with `Retry-After`.
  - Limits survive a restart.
  - Accounts are isolated from each other.
- **Durability:**
  - Worker killed between claim and send: the job is retried after restart.
  - No accepted page is lost after a crash that follows a `202`.
- **APNs outcomes:**
  - `410` removes the device and its session.
  - Retryable errors follow the backoff schedule, then fail.
  - A slow response doesn't block other jobs.
- **Authorization:**
  - Cross-account reads are rejected.
  - A removed device's session is rejected immediately.
  - A Google token issued for a foreign client ID is rejected.
  - Form posts without a CSRF token are rejected.
- **Public view:**
  - `<script>`, `<img onerror>` and `javascript:` links in Markdown render inert.
  - A `/v/` link returns `404` after retention or account deletion.
- **Logs:** captured output contains no token or message text.

**PagerKit:** with a stubbed URL protocol, test that a `401` signs out, that a changed APNs token is re-registered, and that malformed notification payloads are handled without crashing.

**Real-device checklist** (at each phase's milestone):
- Locked iPhone; app killed; Focus on with Time Sensitive allowed and blocked.
- Mac asleep then woken; Mac app quit.
- Airplane mode, then a page sent, then reconnect.
- Sandbox and production builds on the same account.
- Device removed from the web, then a page sent.

## 11. Build sequence

1. **Prove delivery.** A bare endpoint and a hardcoded device token send an audible notification to a real iPhone and a real Mac.
2. **Complete the loop.**
   - Server: Google sign-in (web and apps), accounts, sessions, device registration, trigger URL, durable delivery jobs, public page view, web dashboard home, history API.
   - Apps: sign-in, registration, recent pages.
3. **Pager feel.** Final sound, menu-bar panel polish, notification-disabled and failure states, delivery summaries on the dashboard.
4. **Daily-use polish.** Link regeneration, device management page, retention and session cleanup, account deletion, backups, accessibility (Dynamic Type, VoiceOver, reduced motion).

The first implementation plan covers phases 1 and 2. Phases 3 and 4 get their own plan once phase 2 works on real devices.

## 12. Definition of done (MVP)

- A new user goes from signing in on the website to receiving a test page on a freshly installed app within two minutes.
- One request sounds on both a registered iPhone and Mac under normal conditions.
- Restarting the server loses no accepted page.
- Retrying with the same idempotency key creates one page.
- The old URL stops working immediately after regeneration.
- Notifications turned off are clearly shown in the apps.
- A burst of requests is limited without flooding the devices.
- The real-device checklist passes.
- Performance target: 95% of accepted pages are submitted to APNs within two seconds under normal conditions. End-to-end arrival is measured separately during testing.
