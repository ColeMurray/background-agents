import { describe, expect, it } from "vitest";

import robots from "./robots";

describe("documentation crawler policy", () => {
  it("indexes public docs and advertises the canonical sitemap", () => {
    expect(robots()).toEqual({
      rules: {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/"],
      },
      sitemap: "https://docs.backgroundagents.dev/sitemap.xml",
    });
  });
});
