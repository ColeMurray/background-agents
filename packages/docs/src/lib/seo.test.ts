import { describe, expect, it } from "vitest";

import { createTechArticleJsonLd } from "./seo";

describe("documentation structured data", () => {
  it("describes a public page on the canonical docs host", () => {
    expect(
      createTechArticleJsonLd({
        title: "Run your first task",
        description: "Delegate a first task.",
        path: "/getting-started/first-task",
        lastReviewed: "2026-09-04",
      })
    ).toMatchObject({
      "@context": "https://schema.org",
      "@type": "TechArticle",
      headline: "Run your first task",
      dateModified: "2026-09-04",
      mainEntityOfPage: "https://docs.backgroundagents.dev/getting-started/first-task",
      publisher: { "@type": "Organization", name: "OpenInspect" },
    });
  });
});
