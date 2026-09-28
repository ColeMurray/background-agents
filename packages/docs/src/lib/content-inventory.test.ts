import { execFileSync } from "node:child_process";
import { basename, dirname } from "node:path";
import type * as PageTree from "fumadocs-core/page-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { primarySectionDirectories, sectionLinks } from "./sections";
import { contentFilePath } from "./site";
import type { source as DocumentationSource } from "./source";
import { loadDocumentationSource, repositoryRoot } from "./source.test-support";

const trackedFiles = new Set(
  execFileSync("git", ["ls-files", "-z"], { cwd: repositoryRoot, encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
);

type DocumentationPage = ReturnType<typeof DocumentationSource.getPages>[number];

let loaded: Awaited<ReturnType<typeof loadDocumentationSource>>;
let source: typeof DocumentationSource;
let pages: ReturnType<typeof DocumentationSource.getPages>;

// This suite is the only one that compiles the MDX corpus; keep corpus-wide
// assertions here so a `npm test` run parses every page once.
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

/**
 * Resolves an internal href to a published route the way a rendered page does.
 * `createRelativeLink` rewrites relative hrefs through `source.resolveHref`,
 * which resolves them against the *directory* of the linking file and returns
 * the href unchanged when there is no such page.
 */
function resolveInternalHref(href: string, page: DocumentationPage): string | undefined {
  const resolved = href.startsWith(".") ? source.resolveHref(href, page) : href;
  if (resolved.startsWith(".")) return undefined;
  return source.getPageByHref(resolved)?.page.url;
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
        .filter((href) => !resolveInternalHref(href, page))
        .map((href) => `${page.path} -> ${href}`)
    );

    expect(brokenLinks).toEqual([]);
  });

  it("accepts a relative link between two published content files", () => {
    // No page needs a relative link today. Prove the check above resolves one
    // the way the renderer does, so the first relative link someone writes
    // cannot fail a build that renders correctly.
    const sections = new Map<string, DocumentationPage[]>();
    for (const page of pages) {
      const directory = dirname(page.path);
      sections.set(directory, [...(sections.get(directory) ?? []), page]);
    }
    const siblings = [...sections.values()].find((group) => group.length >= 2);
    if (!siblings) throw new Error("expected two published pages in one section");
    const [from, to] = siblings;

    expect(resolveInternalHref(`./${basename(to.path)}`, from)).toBe(to.url);
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

  it("resolves every primary section to a published page", () => {
    const links = sectionLinks(source.getPageTree());

    expect(links.map((link) => link.url.split("/")[1])).toEqual([...primarySectionDirectories]);
    for (const link of links) {
      expect(source.getPage(link.url.split("/").filter(Boolean))).toBeDefined();
    }
  });
});
