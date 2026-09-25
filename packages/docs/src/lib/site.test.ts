import { describe, expect, it } from "vitest";

import { canonicalUrl, contentFilePath, editOnGitHubUrl, feedbackIssueUrl, site } from "./site";

describe("documentation canonical URLs", () => {
  it("uses OpenInspect as the public product name", () => {
    expect(site.name).toBe("OpenInspect Docs");
  });

  it("keeps every route on the canonical documentation host", () => {
    expect(canonicalUrl("/getting-started/quickstart")).toBe(
      "https://docs.backgroundagents.dev/getting-started/quickstart"
    );
  });
});

describe("repository links", () => {
  it("maps a page path onto the tracked content file", () => {
    expect(contentFilePath("getting-started/quickstart.mdx")).toBe(
      "packages/docs/content/docs/getting-started/quickstart.mdx"
    );
  });

  it("builds an edit link with an explicit branch and the content directory", () => {
    expect(editOnGitHubUrl("getting-started/quickstart.mdx")).toBe(
      "https://github.com/ColeMurray/background-agents/blob/main/packages/docs/content/docs/getting-started/quickstart.mdx"
    );
  });

  it("pre-fills a documentation feedback issue", () => {
    const url = new URL(feedbackIssueUrl("Quickstart"));
    expect(url.origin + url.pathname).toBe(
      "https://github.com/ColeMurray/background-agents/issues/new"
    );
    expect(url.searchParams.get("title")).toBe("Docs feedback: Quickstart");
    expect(url.searchParams.get("labels")).toBe("documentation");
  });
});
