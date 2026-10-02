import MarkdownIt from "markdown-it";

// html: false escapes raw HTML; markdown-it's validateLink refuses javascript:, vbscript:, file: and data: (except images).
const md = new MarkdownIt({ html: false, linkify: false, breaks: true });

const renderLinkOpen =
  md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx]!.attrSet("rel", "noopener noreferrer nofollow");
  return renderLinkOpen(tokens, idx, options, env, self);
};

export function renderMarkdown(source: string): string {
  return md.render(source);
}
