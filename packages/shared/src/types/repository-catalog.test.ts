import { describe, expect, it } from "vitest";
import { controlPlaneReposResponseSchema, repoConfigSchema } from "./repository-catalog";

describe("controlPlaneReposResponseSchema", () => {
  it("parses a valid control-plane repos response with nullable fields", () => {
    const result = controlPlaneReposResponseSchema.safeParse({
      repos: [
        {
          id: 123,
          owner: "Open-Inspect",
          name: "Background-Agents",
          fullName: "Open-Inspect/Background-Agents",
          description: null,
          private: true,
          defaultBranch: "main",
          archived: false,
          language: null,
          metadata: {
            description: "Slack-facing description",
            aliases: ["agents"],
            channelAssociations: ["C123"],
            keywords: ["classifier"],
            defaultEnvironmentId: "env_123",
          },
        },
      ],
      cached: false,
      cachedAt: "2026-07-27T00:00:00.000Z",
    });

    expect(result.success).toBe(true);
  });

  it("rejects malformed repo entries", () => {
    const result = controlPlaneReposResponseSchema.safeParse({
      repos: [{ owner: "Open-Inspect", name: "Background-Agents" }],
      cached: false,
      cachedAt: "2026-07-27T00:00:00.000Z",
    });

    expect(result.success).toBe(false);
  });

  it("rejects repo entries missing canonical repository fields", () => {
    const result = controlPlaneReposResponseSchema.safeParse({
      repos: [
        {
          owner: "Open-Inspect",
          name: "Background-Agents",
          description: null,
          private: true,
          defaultBranch: "main",
        },
      ],
      cached: false,
      cachedAt: "2026-07-27T00:00:00.000Z",
    });

    expect(result.success).toBe(false);
  });

  it("rejects responses missing cache metadata", () => {
    const result = controlPlaneReposResponseSchema.safeParse({
      repos: [
        {
          id: 123,
          owner: "Open-Inspect",
          name: "Background-Agents",
          fullName: "Open-Inspect/Background-Agents",
          description: null,
          private: true,
          defaultBranch: "main",
          archived: false,
        },
      ],
    });

    expect(result.success).toBe(false);
  });
});

describe("repoConfigSchema", () => {
  it("parses cached repo config values with nullable optional fields", () => {
    const result = repoConfigSchema.safeParse({
      id: "open-inspect/background-agents",
      owner: "open-inspect",
      name: "background-agents",
      fullName: "open-inspect/background-agents",
      displayName: "Background-Agents",
      description: "Cached repo",
      defaultBranch: "main",
      private: false,
      language: null,
    });

    expect(result.success).toBe(true);
  });

  it("rejects malformed cached repo config values", () => {
    const result = repoConfigSchema.safeParse({
      id: "open-inspect/background-agents",
      owner: "open-inspect",
      private: false,
    });

    expect(result.success).toBe(false);
  });
});
