import type * as PageTree from "fumadocs-core/page-tree";
import { describe, expect, it } from "vitest";

import { sectionLinks } from "./sections";

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

// "resolves every primary section to a published page" lives in
// content-inventory.test.ts: that suite already compiles the MDX corpus, and
// loading it a second time here would parse every page twice per test run.
