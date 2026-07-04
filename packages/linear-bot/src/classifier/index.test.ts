import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeKV, makeLinearBotEnv } from "../test-helpers";
import { classifyRepo } from "./index";

function mockRepoResponse() {
  return new Response(
    JSON.stringify({
      repos: [
        {
          id: 1,
          owner: "Acme",
          name: "Widgets",
          fullName: "Acme/Widgets",
          description: null,
          private: false,
          defaultBranch: "main",
          archived: false,
          language: null,
          metadata: { description: "Widget service" },
        },
        {
          id: 2,
          owner: "Acme",
          name: "Gadgets",
          fullName: "Acme/Gadgets",
          description: "Gadget service",
          private: false,
          defaultBranch: "main",
          archived: false,
          language: "TypeScript",
        },
      ],
      cached: false,
      cachedAt: "2026-07-04T00:00:00.000Z",
    }),
    { status: 200 }
  );
}

describe("classifyRepo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses valid Anthropic tool-use responses", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv, { INTERNAL_CALLBACK_SECRET: "secret" });
    vi.mocked(env.CONTROL_PLANE.fetch).mockResolvedValue(mockRepoResponse());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            content: [
              {
                type: "tool_use",
                name: "classify_repository",
                input: {
                  repoId: "acme/widgets",
                  confidence: "high",
                  reasoning: "The issue mentions widgets.",
                  alternatives: [],
                },
              },
            ],
          }),
          { status: 200 }
        )
      )
    );

    const result = await classifyRepo(env, "Widget bug", null, [], null, null, null, null);

    expect(result).toEqual({
      repo: expect.objectContaining({ id: "acme/widgets" }),
      confidence: "high",
      reasoning: "The issue mentions widgets.",
      needsClarification: false,
    });
  });

  it("rejects malformed Anthropic responses through the existing fallback result", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv, { INTERNAL_CALLBACK_SECRET: "secret" });
    vi.mocked(env.CONTROL_PLANE.fetch).mockResolvedValue(mockRepoResponse());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ content: null }), { status: 200 }))
    );

    await expect(
      classifyRepo(env, "Widget bug", null, [], null, null, null, null)
    ).resolves.toEqual({
      repo: null,
      confidence: "low",
      reasoning:
        "Could not classify repository automatically. Please reply with the repository name (e.g., `owner/repo`).",
      alternatives: [
        expect.objectContaining({ id: "acme/widgets" }),
        expect.objectContaining({ id: "acme/gadgets" }),
      ],
      needsClarification: true,
    });
  });

  it("parses null repoId from Anthropic tool input", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv, { INTERNAL_CALLBACK_SECRET: "secret" });
    vi.mocked(env.CONTROL_PLANE.fetch).mockResolvedValue(mockRepoResponse());
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            content: [
              {
                type: "tool_use",
                name: "classify_repository",
                input: {
                  repoId: null,
                  confidence: "low",
                  reasoning: "Not enough information.",
                  alternatives: ["acme/widgets"],
                },
              },
            ],
          }),
          { status: 200 }
        )
      )
    );

    const result = await classifyRepo(env, "Question", null, [], null, null, null, null);

    expect(result).toEqual({
      repo: null,
      confidence: "low",
      reasoning: "Not enough information.",
      alternatives: [expect.objectContaining({ id: "acme/widgets" })],
      needsClarification: true,
    });
  });
});
