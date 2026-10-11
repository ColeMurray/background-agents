import { describe, expect, it, vi } from "vitest";
import { MIN_MCP_TOOL_ALLOWLIST_RUNTIME_GENERATION } from "../runtime-manifest";
import { SandboxLaunchContext } from "./launch-context";

describe("SandboxLaunchContext.loadMcpServers", () => {
  const server = {
    type: "remote" as const,
    url: "https://mcp.example.com",
    repoScopes: null,
    enabled: true,
  };

  function launchContext(toolAllowlists: Array<string[] | null>) {
    return new SandboxLaunchContext({
      sessionContext: { getSessionRepositories: () => [], getUserEnvVars: async () => undefined },
      provider: { name: "test", capabilities: { supportsSandboxTimeout: true } },
      config: {
        model: "anthropic/claude-haiku-5-5",
        mcpServerLookup: {
          getDecryptedForSession: async () =>
            toolAllowlists.map((toolAllowlist, i) => ({
              ...server,
              id: `mcp-${i}`,
              name: toolAllowlist ? `limited-${i}` : `open-${i}`,
              toolAllowlist,
            })),
        },
      },
      getLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
    });
  }

  it.each([
    [
      "an older",
      `v${MIN_MCP_TOOL_ALLOWLIST_RUNTIME_GENERATION - 1}-old`,
      ["open-1"],
      ["limited-0"],
    ],
    ["an unparseable", "unversioned", ["open-1"], ["limited-0"]],
    [
      "a current",
      `v${MIN_MCP_TOOL_ALLOWLIST_RUNTIME_GENERATION}-current`,
      ["limited-0", "open-1"],
      [],
    ],
  ])(
    "withholds restricted servers only from %s runtime",
    async (_case, version, sent, withheld) => {
      const loaded = await launchContext([["search"], null]).loadMcpServers([], version);

      expect(loaded.servers?.map((s) => s.name)).toEqual(sent);
      expect(loaded.withheld).toEqual(withheld);
    }
  );

  it("sends no servers when every one is withheld", async () => {
    const loaded = await launchContext([["search"]]).loadMcpServers([], "v1-old");

    expect(loaded).toEqual({ servers: undefined, withheld: ["limited-0"] });
  });
});
