/**
 * Convert standard Markdown to Slack mrkdwn.
 *
 * Agents answer in GitHub-flavored Markdown, but a section block renders
 * mrkdwn, a different dialect: `## heading`, `**bold**`, `- item` and
 * `[text](url)` show up as literal syntax there. Replies short enough for a
 * native `markdown` block skip this entirely; this converter covers the longer
 * ones that must be split across section blocks.
 *
 * Text is escaped (`&`, `<`, `>`) so raw HTML and Slack control sequences such
 * as `<!channel>` in agent output display literally instead of pinging anyone.
 */

import { Lexer, type Token, type Tokens } from "marked";
import { escapeMrkdwnText } from "@open-inspect/shared/slack";

const LIST_INDENT = "    ";
const BULLET = "• ";
const DIVIDER = "———";

export function markdownToMrkdwn(markdown: string): string {
  return renderBlocks(Lexer.lex(markdown, { gfm: true })).trim();
}

function renderBlocks(tokens: Token[]): string {
  return tokens
    .map(renderBlock)
    .filter((block) => block.length > 0)
    .join("\n\n");
}

function renderBlock(token: Token): string {
  switch (token.type) {
    case "heading":
      // mrkdwn has no headings; Slack's own markdown block renders every level the same, as bold.
      return `*${renderInline(token.tokens ?? [])}*`;
    case "paragraph":
      return renderInline(token.tokens ?? []);
    case "list":
      return renderList(token as Tokens.List, 0);
    case "blockquote":
      return renderBlocks(token.tokens ?? [])
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    case "code":
      return fence(escapeMrkdwnText((token as Tokens.Code).text));
    case "table":
      // mrkdwn has no tables; the source's pipe layout stays readable when monospaced.
      return fence(escapeMrkdwnText(token.raw.trim()));
    case "hr":
      return DIVIDER;
    case "space":
      return "";
    case "text":
      return token.tokens ? renderInline(token.tokens) : escapeMrkdwnText(token.text);
    default:
      return escapeMrkdwnText(token.raw.trim());
  }
}

function fence(content: string): string {
  return `\`\`\`\n${content}\n\`\`\``;
}

function renderList(list: Tokens.List, depth: number): string {
  const start = typeof list.start === "number" ? list.start : 1;
  return list.items
    .map((item, index) => {
      const marker = list.ordered ? `${start + index}. ` : BULLET;
      return renderListItem(item, `${LIST_INDENT.repeat(depth)}${marker}`, depth);
    })
    .join("\n");
}

function renderListItem(item: Tokens.ListItem, prefix: string, depth: number): string {
  const lines: string[] = [];
  for (const child of item.tokens) {
    if (child.type === "list") {
      lines.push(renderList(child as Tokens.List, depth + 1));
    } else {
      const rendered = renderBlock(child);
      if (rendered) lines.push(rendered);
    }
  }
  const checkbox = item.task ? (item.checked ? "☑ " : "☐ ") : "";
  return `${prefix}${checkbox}${lines.join("\n")}`;
}

function renderInline(tokens: Token[]): string {
  return tokens.map(renderInlineToken).join("");
}

function renderInlineToken(token: Token): string {
  switch (token.type) {
    case "strong":
      return `*${renderInline(token.tokens ?? [])}*`;
    case "em":
      return `_${renderInline(token.tokens ?? [])}_`;
    case "del":
      return `~${renderInline(token.tokens ?? [])}~`;
    case "codespan":
      // Markdown shows entities in inline code literally, so they are not decoded.
      return `\`${escapeMrkdwnText(token.text)}\``;
    case "link":
      return renderLink(token.href, renderLinkLabel(token.tokens ?? []));
    case "image":
      return renderLink(token.href, escapeMrkdwnText(token.text || token.href));
    case "br":
      return "\n";
    case "text":
      return token.tokens
        ? renderInline(token.tokens)
        : escapeMrkdwnText(decodeEntities(token.text));
    case "escape":
      return escapeMrkdwnText(decodeEntities(token.text));
    default:
      return escapeMrkdwnText(token.raw);
  }
}

/**
 * Slack reads `<!here|x>`, `<@U123|x>` and `<#C123|x>` as mentions, so a link
 * destination like `!here` would notify the channel. Only web and mailto
 * destinations, the same set sanitizeLinks keeps, become Slack links; any
 * other destination is shown as plain text after the label.
 */
const LINKABLE_HREF_RE = /^(?:https?:\/\/|mailto:)[^\s|<>]+$/;

function renderLink(href: string, label: string): string {
  const text = label.trim() ? label : escapeMrkdwnText(href);
  if (LINKABLE_HREF_RE.test(href)) return `<${escapeMrkdwnText(href)}|${text}>`;
  return label.trim() ? `${label} (${escapeMrkdwnText(href)})` : text;
}

/**
 * mrkdwn links can't nest: in `[![CI](badge.png)](ci-url)` the inner link's `>`
 * would end the outer one. An image inside a link label renders as its alt text.
 */
function renderLinkLabel(tokens: Token[]): string {
  return tokens
    .map((token) =>
      token.type === "image" ? escapeMrkdwnText(token.text) : renderInlineToken(token)
    )
    .join("");
}

/**
 * Markdown treats entities in text as the characters they stand for (`&amp;`
 * is `&`). Decode the common ones so escapeMrkdwnText escapes each character
 * once instead of showing the entity literally.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
