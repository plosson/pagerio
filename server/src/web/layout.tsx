import type { Child } from "hono/jsx";

export function Layout(props: { title: string; children?: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>{props.title}</title>
        <link rel="stylesheet" href="/static/style.css" />
        <script src="/static/app.js" defer></script>
      </head>
      <body>
        <main>{props.children}</main>
      </body>
    </html>
  );
}

export function MessagePage(props: { title: string; text: string }) {
  return (
    <Layout title={props.title}>
      <h1>{props.title}</h1>
      <p>{props.text}</p>
      <p>
        <a href="/">Back to Pocket Pager</a>
      </p>
    </Layout>
  );
}
