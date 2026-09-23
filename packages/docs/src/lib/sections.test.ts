import type * as PageTree from "fumadocs-core/page-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { primarySectionDirectories, sectionLinks } from "./sections";
import { loadDocumentationSource } from "./source.test-support";

const page = (name: string, url: string): PageTree.Item => ({ type: "page", name, url });

describe("section links", () => {
  const tree: PageTree.Root = {
    name: "Docs",
    children: [
      page("Home", "/"),
      {
        type: "folder",
        name: "Automations",
        index: page("Overview", "/automations"),
        children: [page("Schedules", "/automations/schedules")],
      },
      {
        type: "folder",
        name: "Get started",
        children: [
          page("Quickstart", "/getting-started/quickstart"),
          page("Concepts", "/getting-started/core-concepts"),
        ],
      },
    ],
  };

  it("links to a section's index page, or else its first page, in the requested order", () => {
    expect(sectionLinks(tree, ["getting-started", "automations"])).toEqual([
      { name: "Get started", url: "/getting-started/quickstart" },
      { name: "Automations", url: "/automations" },
    ]);
  });

  it("skips directories that are not top-level sections", () => {
    expect(sectionLinks(tree, ["missing", "automations"])).toEqual([
      { name: "Automations", url: "/automations" },
    ]);
  });
});

describe("primary sections in the published tree", () => {
  let loaded: Awaited<ReturnType<typeof loadDocumentationSource>>;

  beforeAll(async () => {
    loaded = await loadDocumentationSource();
  }, 60_000);

  afterAll(async () => {
    await loaded?.close();
  });

  it("resolves every primary section to a published page", () => {
    const links = sectionLinks(loaded.source.getPageTree());

    expect(links.map((link) => link.url.split("/")[1])).toEqual([...primarySectionDirectories]);
    for (const link of links) {
      expect(loaded.source.getPage(link.url.split("/").filter(Boolean))).toBeDefined();
    }
  });
});
