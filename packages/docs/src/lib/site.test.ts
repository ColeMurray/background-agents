import { describe, expect, it } from "vitest";

import { canonicalUrl } from "./site";

describe("documentation canonical URLs", () => {
  it("keeps every route on the canonical documentation host", () => {
    expect(canonicalUrl("/getting-started/quickstart")).toBe(
      "https://docs.backgroundagents.dev/getting-started/quickstart"
    );
  });
});
