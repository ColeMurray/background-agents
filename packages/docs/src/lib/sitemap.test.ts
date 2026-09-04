import { describe, expect, it } from "vitest";

import { createSitemapEntries } from "./sitemap";

describe("documentation sitemap", () => {
  it("publishes canonical URLs with their review dates", () => {
    expect(
      createSitemapEntries([
        {
          url: "/getting-started/quickstart",
          lastReviewed: "2026-09-04",
        },
      ])
    ).toEqual([
      {
        url: "https://docs.backgroundagents.dev/getting-started/quickstart",
        lastModified: new Date("2026-09-04T00:00:00.000Z"),
        changeFrequency: "monthly",
        priority: 0.8,
      },
    ]);
  });
});
