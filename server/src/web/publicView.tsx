import { Hono } from "hono";
import { raw } from "hono/html";
import type { AppDeps } from "../app";
import { type DeliveryCounts, deliveryFor, findPublicPage, type PageRow } from "../services/pages";
import { renderHtml } from "./http";
import { Brand, Layout, MessagePage } from "./layout";
import { deliveryStatus } from "./pageList";
import { renderMarkdown } from "./markdown";

function PageView({ page, delivery }: { page: PageRow; delivery: DeliveryCounts }) {
  const created = new Date(page.created_at);
  const status = deliveryStatus(delivery);
  return (
    <Layout title={page.title || "Pocket Pager"}>
      <header class="top">
        <Brand />
      </header>
      <article class="page">
        <p class="meta">
          <time datetime={created.toISOString()} data-local="">
            {created.toUTCString()}
          </time>{" "}
          · <span aria-hidden="true">{status.icon}</span> {status.text}
        </p>
        {page.title && (
          <h1 class="sender" dir="auto">
            {page.title}
          </h1>
        )}
        <div class="display">
          <span class="label">Message</span>
          {page.title ? (
            <p class="text" dir="auto">
              {page.message}
            </p>
          ) : (
            <h1 class="text" dir="auto">
              {page.message}
            </h1>
          )}
        </div>
        {page.url && (
          <a class="button primary wide" href={page.url} rel="noopener noreferrer nofollow">
            <span aria-hidden="true">↗</span> Open link
          </a>
        )}
        {page.details && <div class="details">{raw(renderMarkdown(page.details))}</div>}
        <p class="shared">Shared from a private pager · this page expires after 30 days</p>
      </article>
    </Layout>
  );
}

export function publicViewRoutes(deps: AppDeps): Hono {
  const routes = new Hono();
  routes.get("/v/:publicId", (c) => {
    c.header("X-Robots-Tag", "noindex, nofollow");
    c.header("Cache-Control", "private, no-store");
    const page = findPublicPage(deps, c.req.param("publicId"));
    if (!page) return renderHtml(c, <MessagePage title="Page not found" text="This page doesn't exist or has expired." />, 404);
    return renderHtml(c, <PageView page={page} delivery={deliveryFor(deps, [page]).get(page.id)!} />);
  });
  return routes;
}
