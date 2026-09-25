import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type * as PageTree from "fumadocs-core/page-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { contentFilePath } from "./site";
import type { source as DocumentationSource } from "./source";
import { loadDocumentationSource } from "./source.test-support";

// The repository root, from which `relatedCode` paths are resolved.
const repositoryRoot = resolve(process.cwd(), "../..");
const trackedFiles = new Set(
  execFileSync("git", ["ls-files", "-z"], { cwd: repositoryRoot, encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
);

let loaded: Awaited<ReturnType<typeof loadDocumentationSource>>;
let source: typeof DocumentationSource;
let pages: ReturnType<typeof DocumentationSource.getPages>;

beforeAll(async () => {
  loaded = await loadDocumentationSource();
  source = loaded.source;
  pages = source.getPages();
}, 60_000);

afterAll(async () => {
  await loaded?.close();
});

function pageNodes(node: PageTree.Node | PageTree.Root): PageTree.Item[] {
  if (node.type === "page") return [node];
  if (node.type === "separator") return [];
  const index = node.type === "folder" && node.index ? [node.index] : [];
  return [...index, ...node.children.flatMap(pageNodes)];
}

describe("public documentation inventory", () => {
  it("publishes at least the launch corpus", () => {
    expect(pages.length).toBeGreaterThanOrEqual(13);
  });

  it("reaches every published page from the navigation tree", () => {
    const navigated = new Set(pageNodes(source.getPageTree()).map((node) => node.url));
    const unreachable = pages.map((page) => page.url).filter((url) => !navigated.has(url));

    expect(unreachable).toEqual([]);
  });

  it("tracks every content file in the repository at the path its edit link uses", () => {
    const untracked = pages
      .map((page) => contentFilePath(page.path))
      .filter((path) => !trackedFiles.has(path));

    expect(untracked).toEqual([]);
  });

  it("does not link to missing internal documentation routes", () => {
    const brokenLinks = pages.flatMap((page) =>
      (page.data.extractedReferences ?? [])
        .map((reference) => reference.href)
        .filter((href) => href.startsWith("/") || href.startsWith("."))
        .filter((href) => !href.startsWith("/llms"))
        .filter((href) => !source.getPageByHref(href, { dir: page.path }))
        .map((href) => `${page.path} -> ${href}`)
    );

    expect(brokenLinks).toEqual([]);
  });

  it("keeps every relatedCode reference anchored to a tracked source path", () => {
    const missingSources = pages.flatMap((page) =>
      page.data.relatedCode
        .filter((sourcePath) => !trackedFiles.has(sourcePath))
        .map((sourcePath) => `${page.path} -> ${sourcePath}`)
    );

    expect(missingSources).toEqual([]);
  });

  it("indexes the Markdown representation of every page for LLMs", () => {
    const index = loaded.renderLlmsIndex();
    const missing = pages
      .map((page) => `https://docs.backgroundagents.dev${loaded.getPageMarkdownUrl(page)}`)
      .filter((url) => !index.includes(`](${url})`));

    expect(missing).toEqual([]);
    expect(index).not.toMatch(/\]\(https:\/\/docs\.backgroundagents\.dev\/[^)]*(?<!\.md)\)/);
  });
});
