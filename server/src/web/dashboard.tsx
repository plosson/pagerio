import { Hono } from "hono";
import type { AppDeps } from "../app";
import { getAccount, triggerUrl } from "../services/accounts";
import { listDevices } from "../services/devices";
import { createPage, listPagesForAccount, type PageRow, TEST_PAGE_INPUT, viewUrl } from "../services/pages";
import { renderHtml } from "./http";
import { Layout, MessagePage } from "./layout";
import { currentWebSession, hasValidCsrf } from "./session";

function SignedOut() {
  return (
    <Layout title="Pocket Pager">
      <section class="hero">
        <h1>Pocket Pager</h1>
        <p>A personal pager for your iPhone and Mac. Get one private URL, call it from any script, and your devices sound.</p>
        <a class="button primary" href="/auth/google">
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

function Dashboard(props: {
  email: string;
  url: string;
  deviceCount: number;
  pages: PageRow[];
  csrf: string;
  flash: string | null;
  viewUrlFor: (publicId: string) => string;
}) {
  return (
    <Layout title="Pocket Pager">
      <header class="top">
        <h1>Pocket Pager</h1>
        <form method="post" action="/auth/logout">
          <input type="hidden" name="_csrf" value={props.csrf} />
          <span class="muted">{props.email}</span> <button type="submit" class="link">Sign out</button>
        </form>
      </header>
      {props.flash && (
        <p class="flash" role="status">
          {props.flash}
        </p>
      )}
      <section>
        <h2>Your pager URL</h2>
        <p class="muted">Anyone with this URL can page you. Keep it private.</p>
        <div class="url-row">
          <code id="pager-url">{props.url}</code>
          <button type="button" data-copy="pager-url">
            Copy
          </button>
        </div>
        <pre>
          <code>{curlExamples(props.url)}</code>
        </pre>
        <form method="post" action="/test">
          <input type="hidden" name="_csrf" value={props.csrf} />
          <button type="submit" class="primary">
            Test my pager
          </button>
        </form>
        {props.deviceCount === 0 ? (
          <p class="warning">No devices yet. Install Pocket Pager on your iPhone or Mac and sign in with this Google account.</p>
        ) : (
          <p class="muted">{props.deviceCount === 1 ? "1 device" : `${props.deviceCount} devices`} will be paged.</p>
        )}
      </section>
      <section>
        <h2>Recent pages</h2>
        {props.pages.length === 0 ? (
          <p class="muted">Your pager is ready.</p>
        ) : (
          <ul class="pages">
            {props.pages.map((page) => {
              const created = new Date(page.created_at).toISOString();
              return (
                <li>
                  <a href={props.viewUrlFor(page.public_id)}>
                    <strong>{page.title ?? page.message}</strong>
                    {page.title && <span class="muted"> — {page.message}</span>}
                  </a>
                  <time datetime={created}>{created}</time>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </Layout>
  );
}

export function dashboardRoutes(deps: AppDeps): Hono {
  const routes = new Hono();

  routes.get("/", (c) => {
    const web = currentWebSession(deps, c);
    const account = web ? getAccount(deps, web.session.account_id) : null;
    if (!web || !account) return renderHtml(c, <SignedOut />);
    const pages = listPagesForAccount(deps, account.id, { beforeId: null, limit: 20 });
    const flash = c.req.query("sent")
      ? "Test page sent."
      : c.req.query("limited")
        ? "Too many pages right now. Try again in a minute."
        : null;
    return renderHtml(
      c,
      <Dashboard
        email={account.email}
        url={triggerUrl(deps, account.id)}
        deviceCount={listDevices(deps, account.id).length}
        pages={pages.ok ? pages.pages : []}
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
