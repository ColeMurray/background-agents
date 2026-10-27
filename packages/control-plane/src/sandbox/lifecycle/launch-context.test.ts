import { describe, expect, it, vi } from "vitest";
import { HARNESS_IDS } from "@open-inspect/shared/harnesses";
import { minCompatibleRuntimeVersionFor, runtimeGenerationAtLeast } from "../../image-builds/model";
import {
  MIN_MCP_TOOL_ALLOWLIST_RUNTIME_GENERATION,
  SANDBOX_RUNTIME_VERSION,
} from "../runtime-manifest";
import { SandboxLaunchContext } from "./launch-context";

describe("SandboxLaunchContext.withholdUnenforceableMcpServers", () => {
  const server = {
    type: "remote" as const,
    url: "https://mcp.example.com",
    repoScopes: null,
    enabled: true,
  };
  const servers = [
    { ...server, id: "mcp-0", name: "limited-0", toolAllowlist: ["search"] },
    { ...server, id: "mcp-1", name: "open-1", toolAllowlist: null },
  ];
  const launchContext = new SandboxLaunchContext({
    sessionContext: { getSessionRepositories: () => [], getUserEnvVars: async () => undefined },
    provider: { name: "test", capabilities: { supportsSandboxTimeout: true } },
    config: { model: "anthropic/claude-haiku-5-5" },
    getLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
  });

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
  ])("withholds restricted servers only from %s runtime", (_case, version, sent, withheld) => {
    const result = launchContext.withholdUnenforceableMcpServers(servers, version);

    expect(result.servers?.map((s) => s.name)).toEqual(sent);
    expect(result.withheld).toEqual(withheld);
  });

  it("sends no servers when every one is withheld", () => {
    expect(launchContext.withholdUnenforceableMcpServers([servers[0]], "v1-old")).toEqual({
      servers: undefined,
      withheld: ["limited-0"],
    });
  });

  it("passes through a session without servers", () => {
    expect(launchContext.withholdUnenforceableMcpServers(undefined, "v1-old")).toEqual({
      servers: undefined,
      withheld: [],
    });
  });

  // Fresh launches skip the check, which is only safe while every runtime they
  // can boot enforces allowlists.
  it.each(HARNESS_IDS)("never needs to withhold on a fresh %s launch", (harness) => {
    expect(minCompatibleRuntimeVersionFor(harness)).toBeGreaterThanOrEqual(
      MIN_MCP_TOOL_ALLOWLIST_RUNTIME_GENERATION
    );
    expect(
      runtimeGenerationAtLeast(SANDBOX_RUNTIME_VERSION, MIN_MCP_TOOL_ALLOWLIST_RUNTIME_GENERATION)
    ).toBe(true);
  });
});
