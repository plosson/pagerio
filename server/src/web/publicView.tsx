import { Hono } from "hono";
import { raw } from "hono/html";
import type { AppDeps } from "../app";
import { findPublicPage, type PageRow } from "../services/pages";
import { renderHtml } from "./http";
import { Layout, MessagePage } from "./layout";
import { renderMarkdown } from "./markdown";

function PageView({ page }: { page: PageRow }) {
  const created = new Date(page.created_at).toISOString();
  return (
    <Layout title={page.title || "Pocket Pager"}>
      <article class="page">
        <p class="muted">
          <time datetime={created}>{created}</time>
        </p>
        <h1>{page.title || page.message}</h1>
        {page.title && <p class="message">{page.message}</p>}
        {page.details && <div class="details">{raw(renderMarkdown(page.details))}</div>}
        {page.url && (
          <p>
            <a class="button primary" href={page.url} rel="noopener noreferrer nofollow">
              Open link
            </a>
          </p>
        )}
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
    return renderHtml(c, <PageView page={page} />);
  });
  return routes;
}
