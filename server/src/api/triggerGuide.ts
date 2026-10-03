import type { Limits } from "../config";
import { DEFAULT_MESSAGE, LIMITS } from "../services/pageInput";

/** Markdown served on GET /p/:token, so an agent that curls a pager URL learns how to use it. Plain language (ISO 24495-1). */
export function triggerGuideMarkdown(url: string, limits: Limits): string {
  return `# Pocket Pager

This URL sends a notification to the iPhone and Mac of the person who owns it.

## Send a notification

Send a POST request. A GET request, like this one, only shows this guide.

\`\`\`sh
curl ${url} \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Build finished","message":"All 412 tests passed."}'
\`\`\`

The person gets the notification within seconds. You don't need a password or a key: the URL is the secret, so don't publish it.

## Fields

All fields are optional. The server ignores fields it doesn't know.

| Field | What it is | Maximum |
|---|---|---|
| \`title\` | Notification title | ${LIMITS.title} characters |
| \`message\` | Notification text. Keep it short: the person reads it on a lock screen. If you leave it out, the text is "${DEFAULT_MESSAGE}" | ${LIMITS.message} characters |
| \`details\` | Longer text in Markdown, such as logs or lists. It shows only when the person opens the page, not in the notification. | ${LIMITS.details.toLocaleString("en-US")} characters |
| \`url\` | A link the person can open from the notification. It must start with \`http://\` or \`https://\`. | ${LIMITS.url} characters |
| \`group\` | A name that groups related notifications on the device, such as \`ci\` or \`backups\` | ${LIMITS.group} characters |

## Examples

You need the person's input:

\`\`\`sh
curl ${url} \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Agent needs your input","message":"Should I run the database migration on production?","group":"agent"}'
\`\`\`

Something failed, with details and a link:

\`\`\`sh
curl ${url} \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Nightly backup failed","message":"Disk full on db-1.","details":"**Error:** No space left on device\\n\\n- Free space: 0 B\\n- Last success: 2 days ago","url":"https://example.com/backups/db-1","group":"backups"}'
\`\`\`

Without JSON, the body text becomes the message:

\`\`\`sh
curl -d "Your deployment is ready" ${url}
\`\`\`

With no body at all, the message is "${DEFAULT_MESSAGE}":

\`\`\`sh
curl -X POST ${url}
\`\`\`

## Retry without sending twice

Add an \`Idempotency-Key\` header (at most ${LIMITS.idempotencyKey} characters). If you send the same key again within 24 hours, the server returns the first notification and doesn't send a new one.

\`\`\`sh
curl ${url} \\
  -H "Idempotency-Key: deploy-42" \\
  -d "Deploy 42 is live"
\`\`\`

## Server responses

If it works, the server answers \`202\`:

\`\`\`json
{ "id": "...", "status": "accepted", "view_url": "https://.../v/..." }
\`\`\`

\`view_url\` is a web page that shows the whole notification, including \`details\`.

If it fails, the server answers \`{"error": {"code": "...", "message": "..."}}\`:

| Status | Code | What to do |
|---|---|---|
| 400 | \`invalid_input\` | Read \`message\`, fix the field it names and send again. |
| 404 | \`not_found\` | This URL doesn't exist. Ask the owner for their current URL. |
| 413 | \`payload_too_large\` | The body is over ${LIMITS.bodyBytes.toLocaleString("en-US")} bytes. Shorten \`details\`. |
| 429 | \`rate_limited\` | Too many notifications. Wait the number of seconds in the \`Retry-After\` header, then send again. |
| 500 | \`internal\` | The server failed. Try again later. |

## Rules

- Send a notification only when the person needs to know something or act. Don't send one for every log line.
- You can send at most ${limits.pagesPerMinute} notifications per minute and ${limits.pagesPerDay} per day.
- The body must be UTF-8 text of at most ${LIMITS.bodyBytes.toLocaleString("en-US")} bytes.
`;
}
