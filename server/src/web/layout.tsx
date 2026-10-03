import type { Child } from "hono/jsx";
import { APP_VERSION } from "../version";

export function Layout(props: { title: string; wide?: boolean; children?: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>{props.title}</title>
        <link rel="icon" href="/static/favicon.png" />
        <link rel="stylesheet" href="/static/style.css" />
        <script src="/static/app.js" defer></script>
      </head>
      <body>
        <main class={props.wide ? "wide-layout" : undefined}>{props.children}</main>
        <footer class="version">v{APP_VERSION}</footer>
      </body>
    </html>
  );
}

export function Brand() {
  return (
    <a class="brand" href="/">
      <img src="/static/icon.png" alt="" width="36" height="36" />
      Pocket Pager
    </a>
  );
}

export function MessagePage(props: { title: string; text: string }) {
  return (
    <Layout title={props.title}>
      <header class="top">
        <Brand />
      </header>
      <h1>{props.title}</h1>
      <p>{props.text}</p>
      <p>
        <a href="/">Back to Pocket Pager</a>
      </p>
    </Layout>
  );
}
