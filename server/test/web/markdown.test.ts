import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../../src/web/markdown";

describe("renderMarkdown", () => {
  test("renders ordinary Markdown", () => {
    const html = renderMarkdown("**bold** and `code`\n\n- item");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<li>item</li>");
  });

  test("escapes raw HTML instead of rendering it", () => {
    for (const attack of ["<script>alert(1)</script>", '<img src=x onerror="alert(1)">', "<iframe src=//evil></iframe>", "<a href=javascript:alert(1)>x</a>"]) {
      const html = renderMarkdown(attack);
      expect(html).not.toMatch(/<(script|img|iframe|a)\b/i);
      expect(html).toContain("&lt;");
    }
  });

  test("refuses dangerous link schemes", () => {
    for (const href of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "vbscript:msgbox(1)", "file:///etc/passwd", "data:text/html,<script>alert(1)</script>"]) {
      expect(renderMarkdown(`[click](${href})`)).not.toContain("href=");
    }
  });

  test("safe links are kept and marked noopener noreferrer nofollow", () => {
    expect(renderMarkdown("[docs](https://example.com)")).toContain('<a href="https://example.com" rel="noopener noreferrer nofollow">docs</a>');
  });
});
