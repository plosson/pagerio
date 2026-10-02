import type { Limits } from "../config";
import { DEFAULT_MESSAGE, LIMITS } from "../services/pageInput";

/** Markdown served on GET /p/:token, so an agent that curls a pager URL learns how to use it. */
export function triggerGuideMarkdown(url: string, limits: Limits): string {
  return `# Pocket Pager: how to use this pager URL

This URL sends a push notification (a "page") to the phone and Mac of the person who owns it.

- Send a page with **POST**. A GET (like this one) never sends anything. It only shows this guide.
- No authentication is needed. The URL is the secret, so do not publish it.
- Each successful POST sends one notification right away.

Pager URL:

\`\`\`
${url}
\`\`\`

## 1. Simplest page: an empty POST

The notification says: ${DEFAULT_MESSAGE}

\`\`\`sh
curl -X POST ${url}
\`\`\`

## 2. Plain-text message

Any body that is not JSON becomes the message. The text is trimmed.

\`\`\`sh
curl -d "Your deployment is ready" ${url}
\`\`\`

## 3. JSON page with all fields

Send \`Content-Type: application/json\` with a JSON object. All fields are optional. Unknown fields are ignored.

\`\`\`sh
curl ${url} \\
  -H "Content-Type: application/json" \\
  -d '{
    "title": "Build finished",
    "message": "main is green. Ready for review.",
    "details": "## Summary\\n\\n- 412 tests passed\\n- Coverage: 87%",
    "url": "https://ci.example.com/builds/1234",
    "group": "ci"
  }'
\`\`\`

| Field | Max length | Format | Where it shows |
|---|---|---|---|
| \`title\` | ${LIMITS.title} characters | Plain text | Notification title and page view |
| \`message\` | ${LIMITS.message} characters | Plain text | Notification body (cut off when long) and page view. Defaults to "${DEFAULT_MESSAGE}" |
| \`details\` | ${LIMITS.details.toLocaleString("en-US")} characters | Markdown | Page view only (not in the notification) |
| \`url\` | ${LIMITS.url} characters | Absolute \`http\` or \`https\` URL | **Open link** action on the notification and button on the page view |
| \`group\` | ${LIMITS.group} characters | Plain text | Groups related notifications together on the device |

Use \`message\` for the short thing the person must know now. Put logs, lists and longer context in \`details\`.

## 4. More examples

Long-running task finished, with a link:

\`\`\`sh
curl ${url} \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Data export done","message":"export-2026.csv is ready (1.2 GB).","url":"https://example.com/exports/42"}'
\`\`\`

Asking the person for input (an agent that is blocked):

\`\`\`sh
curl ${url} \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Agent needs your input","message":"Should I run the database migration on production?","group":"agent"}'
\`\`\`

Failure with details in Markdown:

\`\`\`sh
curl ${url} \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Nightly backup failed","message":"Disk full on db-1.","details":"**Error:** No space left on device\\n\\n- Free space: 0 B\\n- Last success: 2 days ago","group":"backups"}'
\`\`\`

Safe retries: send the same \`Idempotency-Key\` header (max ${LIMITS.idempotencyKey} characters). Within 24 hours, a retry with the same key returns the first page instead of sending a new one.

\`\`\`sh
curl ${url} \\
  -H "Idempotency-Key: deploy-42" \\
  -d "Deploy 42 is live"
\`\`\`

## 5. Responses

Success is \`202 Accepted\`:

\`\`\`json
{ "id": "...", "status": "accepted", "view_url": "https://.../v/..." }
\`\`\`

\`view_url\` is a web page that shows the full page, including \`details\`.

Errors have the shape \`{"error": {"code": "...", "message": "..."}}\`:

| Status | Code | Meaning and what to do |
|---|---|---|
| 400 | \`invalid_input\` | The body is not valid. Read \`message\`, fix the field and send again. |
| 404 | \`not_found\` | This pager URL does not exist or was regenerated. Ask the owner for the current URL. |
| 413 | \`payload_too_large\` | The body is over ${LIMITS.bodyBytes.toLocaleString("en-US")} bytes. Shorten \`details\`. |
| 429 | \`rate_limited\` | Too many pages. Wait for the number of seconds in the \`Retry-After\` header. |
| 500 | \`internal\` | Server failure. Retry later. |

## 6. Limits

- At most ${limits.pagesPerMinute} pages per minute and ${limits.pagesPerDay} pages per day for this pager.
- Maximum body size: ${LIMITS.bodyBytes.toLocaleString("en-US")} bytes. The body must be UTF-8.
- Page only when a person needs to know or act. Do not send one page per log line.
`;
}
