import { Hono } from "hono";
import type { AppDeps } from "../app";
import { getAccount, triggerUrl } from "../services/accounts";
import { listDevices } from "../services/devices";
import { countRetainedPages, createPage, type DeliveryCounts, deliveryFor, listPagesForAccount, type PageRow, TEST_PAGE_INPUT, viewUrl } from "../services/pages";
import { renderHtml } from "./http";
import { asset, Brand, Layout, MessagePage } from "./layout";
import { deliveryStatus, devicesLine, groupBursts, NEW_PAGE_MS, type PageGroup, relativeTime } from "./pageList";
import { currentWebSession, hasValidCsrf } from "./session";

function SignedOut(props: { baseUrl: string }) {
  return (
    <Layout title="Pocket Pager">
      <section class="welcome">
        <img class="logo" src={asset("icon.png")} alt="Pocket Pager" width="112" height="112" />
        <h1>Your personal pager.</h1>
        <p class="lede">One private URL. Call it from any script, and your iPhone and Mac ring.</p>
        <p class="display">
          <span class="label">Try it</span>
          <code class="text">curl -d "Build finished" {props.baseUrl}/p/…</code>
        </p>
        <a class="button strong wide" href="/auth/google">
          Sign in with Google
        </a>
      </section>
    </Layout>
  );
}

function curlExamples(url: string): string {
  return [
    `curl -X POST ${url}`,
    `curl -d "Your deployment is ready" ${url}`,
    `curl ${url} \\\n  -H "Content-Type: application/json" \\\n  -d '{"title":"Build finished","message":"Ready for review","url":"https://example.com"}'`,
  ].join("\n\n");
}

export const PAGE_STEP = 20;
const MAX_PAGES = 3000; // 30 days at the 100-a-day cap
const BATCH = 200;

function rowCount(raw: string | undefined): number {
  const n = raw && /^\d+$/.test(raw) ? Number(raw) : PAGE_STEP;
  return Math.min(Math.max(n, PAGE_STEP), MAX_PAGES);
}

/** Loads pages until `rows` rows are complete: a burst can hold many pages but is one row. */
function loadRows(deps: AppDeps, accountId: string, rows: number): { groups: PageGroup[]; pages: number } {
  const pages: PageRow[] = [];
  let before: string | null = null;
  do {
    const listed = listPagesForAccount(deps, accountId, { beforeId: before, limit: BATCH });
    if (!listed.ok) break;
    pages.push(...listed.pages);
    before = listed.nextBefore;
  } while (before && pages.length < MAX_PAGES && groupBursts(pages, new Map()).length <= rows);
  const groups = groupBursts(pages, deliveryFor(deps, pages)).slice(0, rows);
  return { groups, pages: groups.reduce((sum, group) => sum + group.count, 0) };
}

function Status({ counts }: { counts: DeliveryCounts }) {
  const status = deliveryStatus(counts);
  return (
    <span class={status.kind}>
      <span aria-hidden="true">{status.icon}</span> {status.text}
    </span>
  );
}

function PageItem(props: { group: PageGroup; href: string; isNew: boolean; now: number }) {
  const { page, count, delivery } = props.group;
  return (
    <li>
      <a href={props.href}>
        <span class={props.isNew ? "dot new" : "dot"} aria-hidden="true"></span>
        <span>
          <span class="row-title sender" dir="auto">
            {page.title || page.message}
            {count > 1 && (
              <span class="badge" aria-label={`${count} identical pages`}>
                ×{count}
              </span>
            )}
          </span>
          {page.title && (
            <span class="row-message sender" dir="auto">
              {page.message}
            </span>
          )}
          <span class="row-meta">
            <time datetime={new Date(page.created_at).toISOString()}>{relativeTime(page.created_at, props.now)}</time>
            <Status counts={delivery} />
            {page.url && (
              <span>
                <span aria-hidden="true">↗</span> link
              </span>
            )}
          </span>
        </span>
      </a>
    </li>
  );
}

function Dashboard(props: {
  email: string;
  url: string;
  baseUrl: string;
  platforms: string[];
  groups: PageGroup[];
  /** Pages inside the rows shown; a burst row holds several. */
  shown: number;
  total: number;
  now: number;
  csrf: string;
  flash: { text: string; problem: boolean } | null;
  viewUrlFor: (publicId: string) => string;
}) {
  const hasMore = props.shown < props.total;
  return (
    <Layout title="Pocket Pager" wide>
      <header class="top">
        <Brand />
        <form method="post" action="/auth/logout" class="account">
          <input type="hidden" name="_csrf" value={props.csrf} />
          <span class="email">{props.email}</span>
          <button type="submit" class="link">
            Sign out
          </button>
        </form>
      </header>
      {props.flash && (
        <p class={props.flash.problem ? "flash problem" : "flash"} role="status">
          {props.flash.text}
        </p>
      )}
      <div class="columns">
        <section aria-label="Your pager">
          <p class="display">
            <span class="label">Your pager</span>
            <code class="text fit" id="pager-url">
              {props.url}
            </code>
          </p>
          <p class="note">Anyone with this URL can page you. Keep it private.</p>
          <div class="actions">
            <button type="button" data-copy="pager-url">
              <span aria-hidden="true">⧉</span> <span>Copy</span>
            </button>
            <form method="post" action="/test">
              <input type="hidden" name="_csrf" value={props.csrf} />
              <button type="submit" class="primary">
                <span aria-hidden="true">🔔</span> Test my pager
              </button>
            </form>
          </div>
          {props.platforms.length === 0 ? (
            <p class="status">
              <span aria-hidden="true">○</span> No devices yet. Install Pocket Pager on your iPhone or Mac and sign in with this Google account.
            </p>
          ) : (
            <p class="status">
              <span aria-hidden="true">✓</span> {devicesLine(props.platforms)}
            </p>
          )}
          <details id="how">
            <summary>How to send a page</summary>
            <pre>
              <code>{curlExamples(props.url)}</code>
            </pre>
            <p class="small muted">
              Open your pager URL in a browser for the full guide: titles, links, Markdown details and grouping.
            </p>
          </details>
        </section>
        <section>
          <h2>Recent pages</h2>
          {props.groups.length === 0 ? (
            <p class="empty">
              Your pager is ready. Send a test, or call your URL from a script.
              <br />
              <a href="#how">How to send a page ›</a>
            </p>
          ) : (
            <ul class="pages">
              {props.groups.map((group, i) => (
                <PageItem group={group} href={props.viewUrlFor(group.page.public_id)} isNew={i === 0 && props.now - group.page.created_at < NEW_PAGE_MS} now={props.now} />
              ))}
              {hasMore && (
                <li class="more">
                  <span>
                    Showing {props.shown.toLocaleString("en-US")} of {props.total.toLocaleString("en-US")} pages
                  </span>
                  <a href={`/?show=${props.groups.length + PAGE_STEP}`}>Show {PAGE_STEP} more</a>
                </li>
              )}
            </ul>
          )}
          {props.groups.length > 0 && <p class="small muted">Pages are kept for 30 days.</p>}
        </section>
      </div>
    </Layout>
  );
}

export function dashboardRoutes(deps: AppDeps): Hono {
  const routes = new Hono();

  routes.get("/", (c) => {
    c.header("Cache-Control", "no-store");
    const web = currentWebSession(deps, c);
    const account = web ? getAccount(deps, web.session.account_id) : null;
    if (!web || !account) return renderHtml(c, <SignedOut baseUrl={deps.config.publicBaseUrl} />);
    const rows = loadRows(deps, account.id, rowCount(c.req.query("show")));
    const flash = c.req.query("sent")
      ? { text: "Test page sent.", problem: false }
      : c.req.query("limited")
        ? { text: "Too many pages right now. Try again in a minute.", problem: true }
        : null;
    return renderHtml(
      c,
      <Dashboard
        email={account.email}
        url={triggerUrl(deps, account.id)}
        baseUrl={deps.config.publicBaseUrl}
        platforms={listDevices(deps, account.id).map((device) => device.platform)}
        groups={rows.groups}
        shown={rows.pages}
        total={countRetainedPages(deps, account.id)}
        now={deps.now()}
        csrf={web.csrf}
        flash={flash}
        viewUrlFor={(publicId) => viewUrl(deps.config, publicId)}
      />,
    );
  });

  routes.post("/test", async (c) => {
    const web = currentWebSession(deps, c);
    if (!web) return c.redirect("/", 303);
    if (!(await hasValidCsrf(c, web))) {
      return renderHtml(c, <MessagePage title="Form expired" text="This form expired. Go back and try again." />, 403);
    }
    const result = createPage(deps, { accountId: web.session.account_id, input: TEST_PAGE_INPUT, source: "test", idempotencyKey: null });
    if (!result.ok) return c.redirect("/?limited=1", 303);
    deps.worker.wake();
    return c.redirect("/?sent=1", 303);
  });

  return routes;
}
