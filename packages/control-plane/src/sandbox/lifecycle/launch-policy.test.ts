import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../../logger";
import { LaunchPolicyResolver } from "./launch-policy";
import { createMockProvider, createMockSession, createTestConfig } from "./test-helpers";
import type { SessionRepositoryInfo } from "../provider";

function fixture(repositories: SessionRepositoryInfo[] = []) {
  const calls: string[] = [];
  const context = {
    getUserEnvVars: vi.fn(async () => {
      calls.push("secrets");
      return { SYNTHETIC: "value" };
    }),
    getSessionRepositories: vi.fn(() => {
      calls.push("repositories");
      return repositories;
    }),
  };
  const config = {
    ...createTestConfig(),
    mcpServerLookup: {
      getDecryptedForSession: vi.fn(async () => {
        calls.push("mcp");
        return [];
      }),
    },
    slackAgentNotifyLookup: {
      isEnabledForRepo: vi.fn(async () => {
        calls.push("slack");
        return true;
      }),
    },
  };
  const images = {
    getLatestReady: vi.fn(async () => {
      calls.push("image");
      return null;
    }),
    markRestoreFailed: vi.fn(async () => true),
  };
  const provider = createMockProvider();
  const resolver = new LaunchPolicyResolver(
    context,
    provider,
    config,
    images,
    createLogger("launch-policy-test")
  );
  return { calls, context, config, images, resolver, provider };
}

describe("launch policy ownership", () => {
  it.each(["fresh", "restore"] as const)(
    "preserves sequential %s preparation and awaits secrets first",
    async (mode) => {
      const f = fixture([{ repoOwner: "group", repoName: "repo", baseBranch: "main" }]);
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.context.getUserEnvVars.mockImplementationOnce(async () => {
        f.calls.push("secrets");
        await waiting;
        return { SYNTHETIC: "value" };
      });
      const prepared = f.resolver.resolve(createMockSession(), mode);
      expect(f.calls).toEqual(["secrets"]);
      release();
      const { inputs } = await prepared;
      expect(f.calls).toEqual(
        mode === "fresh"
          ? ["secrets", "repositories", "image", "mcp", "slack"]
          : ["secrets", "repositories", "slack", "mcp"]
      );
      expect(inputs.userEnvVars).toEqual({ SYNTHETIC: "value" });
      expect(inputs.agentSlackNotifyEnabled).toBe(true);
      expect(inputs.repositories).toBeUndefined();
      expect(f.provider.createSandbox).not.toHaveBeenCalled();
      expect(f.images.markRestoreFailed).not.toHaveBeenCalled();
    }
  );

  it.each(["fresh", "restore"] as const)(
    "fails %s before optional lookups when secret loading fails",
    async (mode) => {
      const f = fixture();
      f.context.getUserEnvVars.mockRejectedValueOnce(new Error("synthetic secret failure"));
      await expect(f.resolver.resolve(createMockSession(), mode)).rejects.toThrow(
        "synthetic secret failure"
      );
      expect(f.config.mcpServerLookup.getDecryptedForSession).not.toHaveBeenCalled();
      expect(f.images.getLatestReady).not.toHaveBeenCalled();
    }
  );

  it("keeps image/MCP/Slack degradation and invalid persisted settings independent", async () => {
    const f = fixture([{ repoOwner: "group", repoName: "repo", baseBranch: "main" }]);
    f.images.getLatestReady.mockRejectedValueOnce(new Error("image lookup unavailable"));
    f.config.mcpServerLookup.getDecryptedForSession.mockRejectedValueOnce(
      new Error("MCP unavailable")
    );
    f.config.slackAgentNotifyLookup.isEnabledForRepo.mockRejectedValueOnce(
      new Error("Slack unavailable")
    );
    const result = await f.resolver.resolve(
      createMockSession({ sandbox_settings: "not-json" }),
      "fresh"
    );
    expect(result.selectedImage).toBeNull();
    expect(result.inputs).toMatchObject({ sandboxSettings: {}, agentSlackNotifyEnabled: false });
    expect(result.inputs.mcpServers).toBeUndefined();
    expect(f.images.markRestoreFailed).not.toHaveBeenCalled();
  });

  it("preserves pinned single-repository inputs and saved harness/model choices", async () => {
    const repositories = [
      { repoOwner: "group/subgroup", repoName: "repo", baseBranch: "feature", baseSha: "abc123" },
    ];
    const f = fixture(repositories);
    const { inputs } = await f.resolver.resolve(
      createMockSession({ harness: "claude", model: "anthropic/claude-sonnet-4-6" }),
      "restore"
    );
    expect(inputs).toMatchObject({
      repositories,
      harness: "claude",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
  });

  it("does not fall from an environment image miss into repo-scoped image lookup", async () => {
    const f = fixture([{ repoOwner: "group", repoName: "repo", baseBranch: "main" }]);
    await f.resolver.resolve(
      createMockSession({ environment_id: "environment-contract" }),
      "fresh"
    );
    expect(f.images.getLatestReady).toHaveBeenCalledExactlyOnceWith({
      kind: "environment",
      id: "environment-contract",
    });
  });

  it("resolves resume settings without any launch input lookup", () => {
    const f = fixture();
    expect(
      f.resolver.resolveSettings(
        createMockSession({ sandbox_settings: JSON.stringify({ sandboxTimeoutMs: 7_200_000 }) })
      )
    ).toMatchObject({ timeoutSeconds: 7200 });
    expect(f.calls).toEqual([]);
  });

  it("does not cache secrets across separate launches", async () => {
    const f = fixture();
    await f.resolver.resolve(createMockSession(), "fresh");
    f.context.getUserEnvVars.mockResolvedValueOnce({ SYNTHETIC: "rotated" });
    const result = await f.resolver.resolve(createMockSession(), "restore");
    expect(result.inputs.userEnvVars).toEqual({ SYNTHETIC: "rotated" });
    expect(f.context.getUserEnvVars).toHaveBeenCalledTimes(2);
  });
});
