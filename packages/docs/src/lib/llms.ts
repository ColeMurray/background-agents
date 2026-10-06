import type * as PageTree from "fumadocs-core/page-tree";

import { canonicalUrl, site } from "./site";
import { getPageMarkdownUrl, source } from "./source";

const TAB = "  ";

function listItem(name: string, description: string | undefined, indent: number): string {
  const prefix = TAB.repeat(indent);
  const trimmed = description?.trim() ?? "";
  return trimmed ? `${prefix}- ${name}: ${trimmed}` : `${prefix}- ${name}`;
}

function markdownLink(title: string, url: string): string {
  return `[${title.replace(/([[\]])/g, "\\$1")}](${url.replace(/([()])/g, "\\$1")})`;
}

function nodeName(node: PageTree.Node | PageTree.Root): string {
  return typeof node.name === "string" ? node.name : "";
}

function renderNode(node: PageTree.Node, indent: number): string[] {
  switch (node.type) {
    case "page": {
      const page = source.getNodePage(node);
      if (!page) return [];
      const url = canonicalUrl(getPageMarkdownUrl(page));
      return [listItem(markdownLink(page.data.title, url), page.data.description, indent)];
    }
    case "folder": {
      const lines = [listItem(nodeName(node), undefined, indent)];
      if (node.index) lines.push(...renderNode(node.index, indent + 1));
      for (const child of node.children) lines.push(...renderNode(child, indent + 1));
      return lines;
    }
    case "separator":
      return [listItem(`**${nodeName(node) || "Separator"}**`, undefined, indent)];
  }
}

/**
 * The `llms.txt` index. Every entry links to the page's clean Markdown
 * representation rather than its HTML route, which is what an LLM index is for.
 */
export function renderLlmsIndex(): string {
  const tree = source.getPageTree();
  const lines = [`# ${nodeName(tree) || site.name}`, "", `> ${site.description}`, ""];
  for (const child of tree.children) lines.push(...renderNode(child, 0));
  lines.push("", `Full corpus: ${canonicalUrl("/llms-full.txt")}`);
  return lines.join("\n");
}
