import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoConfig } from "@open-inspect/shared/types/repository-catalog";
import {
  anthropicMessagesResponseSchema,
  CLASSIFIER_REQUEST_TIMEOUT_MS,
  classifyRepo,
  classifyToolInputSchema,
} from "./index";
import { createFakeKV, makeLinearBotEnv } from "../test-helpers";

const { getAvailableRepos, buildRepoDescriptions } = vi.hoisted(() => ({
  getAvailableRepos: vi.fn(),
  buildRepoDescriptions: vi.fn(),
}));

vi.mock("./repos", () => ({ getAvailableRepos, buildRepoDescriptions }));

const repos: RepoConfig[] = ["api", "web"].map((name) => ({
  id: `acme/${name}`,
  owner: "acme",
  name,
  fullName: `acme/${name}`,
  displayName: name,
  description: `${name} repository`,
  defaultBranch: "main",
  private: true,
}));

beforeEach(() => {
  getAvailableRepos.mockResolvedValue(repos);
  buildRepoDescriptions.mockResolvedValue("- acme/api\n- acme/web");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("anthropicMessagesResponseSchema", () => {
  it("parses a response with the consumed tool block fields", () => {
    const parsed = anthropicMessagesResponseSchema.safeParse({
      id: "msg_1",
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "classify_repository",
          input: {
            repoId: "org/repo",
            confidence: "high",
            reasoning: "The issue names the repo.",
            alternatives: [],
          },
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects a response without content", () => {
    const parsed = anthropicMessagesResponseSchema.safeParse({ id: "msg_1" });

    expect(parsed.success).toBe(false);
  });
});

describe("classifyToolInputSchema", () => {
  it("parses a valid classification tool input", () => {
    const parsed = classifyToolInputSchema.safeParse({
      repoId: "org/repo",
      confidence: "medium",
      reasoning: "The labels match this repository.",
      alternatives: ["org/other"],
    });

    expect(parsed.success).toBe(true);
  });

  it("parses a null repoId for low-confidence classifications", () => {
    const parsed = classifyToolInputSchema.safeParse({
      repoId: null,
      confidence: "low",
      reasoning: "No repository was a clear match.",
      alternatives: ["org/api", "org/web"],
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects malformed or partial tool input", () => {
    const parsed = classifyToolInputSchema.safeParse({
      repoId: "org/repo",
      confidence: "certain",
      reasoning: "Invalid confidence value.",
    });

    expect(parsed.success).toBe(false);
  });
});

describe("classifyRepo", () => {
  it("falls back to clarification when the classifier request times out", async () => {
    const timeoutSignal = AbortSignal.abort(new DOMException("timed out", "TimeoutError"));
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutSignal);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init) => {
        expect(init?.signal).toBe(timeoutSignal);
        throw timeoutSignal.reason;
      })
    );
    const { kv } = createFakeKV();

    const result = await classifyRepo(
      makeLinearBotEnv(kv),
      "Update service",
      null,
      [],
      null,
      "Engineering",
      "ENG",
      null
    );

    expect(timeoutSpy).toHaveBeenCalledWith(CLASSIFIER_REQUEST_TIMEOUT_MS);
    expect(result).toEqual({
      repo: null,
      confidence: "low",
      reasoning:
        "Could not classify repository automatically. Please reply with the repository name (e.g., `owner/repo`).",
      alternatives: repos,
      needsClarification: true,
    });
  });
});
