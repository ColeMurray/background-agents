import { describe, expect, it } from "vitest";

import { controlPlaneReposResponseSchema, repoConfigSchema, repoMetadataSchema } from "./index";

describe("repository schemas", () => {
  it("parses a valid control-plane repos response", () => {
    const result = controlPlaneReposResponseSchema.safeParse({
      repos: [
        {
          id: 1,
          owner: "acme",
          name: "widgets",
          fullName: "acme/widgets",
          description: null,
          private: true,
          defaultBranch: "main",
          archived: false,
          language: null,
          topics: ["typescript"],
          metadata: {
            description: "Widget service",
            aliases: ["widgets-api"],
            channelAssociations: ["C123"],
            keywords: ["widget"],
          },
        },
      ],
      cached: false,
      cachedAt: "2026-07-04T00:00:00.000Z",
    });

    expect(result.success).toBe(true);
  });

  it("rejects malformed or partial repos responses", () => {
    expect(controlPlaneReposResponseSchema.safeParse({ repos: "nope" }).success).toBe(false);
    expect(
      controlPlaneReposResponseSchema.safeParse({
        repos: [{ owner: "acme", name: "widgets" }],
        cached: false,
        cachedAt: "2026-07-04T00:00:00.000Z",
      }).success
    ).toBe(false);
  });

  it("parses nullable repository fields from upstream", () => {
    expect(
      controlPlaneReposResponseSchema.safeParse({
        repos: [
          {
            id: 1,
            owner: "acme",
            name: "widgets",
            fullName: "acme/widgets",
            description: null,
            private: false,
            defaultBranch: "main",
            archived: false,
            language: null,
          },
        ],
        cached: true,
        cachedAt: "2026-07-04T00:00:00.000Z",
      }).success
    ).toBe(true);
  });

  it("parses cached repo configs and metadata", () => {
    expect(
      repoConfigSchema.array().safeParse([
        {
          id: "acme/widgets",
          owner: "acme",
          name: "widgets",
          fullName: "acme/widgets",
          displayName: "widgets",
          description: "Widget service",
          defaultBranch: "main",
          private: false,
          language: null,
        },
      ]).success
    ).toBe(true);
    expect(repoMetadataSchema.safeParse({ aliases: ["widgets-api"] }).success).toBe(true);
  });
});
