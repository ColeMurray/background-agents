import { describe, expect, it } from "vitest";

import { parsePublicPage } from "./content-policy";

describe("public documentation content policy", () => {
  it("rejects internal content from the public collection", () => {
    expect(() =>
      parsePublicPage({
        title: "Internal rollout notes",
        description: "Operational notes that must stay private.",
        audience: "internal",
        owner: "platform",
        status: "published",
        lastReviewed: "2026-09-04",
      })
    ).toThrow(/audience/i);
  });
});
