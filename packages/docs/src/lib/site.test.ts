import { describe, expect, it } from "vitest";

import { canonicalUrl, site } from "./site";

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
