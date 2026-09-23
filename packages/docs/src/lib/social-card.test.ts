import type * as PageTree from "fumadocs-core/page-tree";
import { describe, expect, it } from "vitest";

import { site } from "./site";
import { socialCard } from "./social-card";

const tree: PageTree.Root = {
  name: "Docs",
  children: [
    { type: "page", name: "Home", url: "/" },
    {
      type: "folder",
      name: "Working in a session",
      children: [{ type: "page", name: "Child sessions", url: "/sessions/child-sessions" }],
    },
  ],
};

describe("social card", () => {
  it("shows the section, title, and description of a page", () => {
    expect(
      socialCard(
        {
          url: "/sessions/child-sessions",
          data: { title: "Child sessions", description: "Split work across sessions." },
        },
        tree
      )
    ).toEqual({
      section: "Working in a session",
      title: "Child sessions",
      description: "Split work across sessions.",
    });
  });

  it("keeps the Documentation card for the home page", () => {
    expect(
      socialCard({ url: "/", data: { title: "OpenInspect documentation", description: "x" } }, tree)
    ).toEqual({ title: "Documentation", description: site.description });
  });
});
