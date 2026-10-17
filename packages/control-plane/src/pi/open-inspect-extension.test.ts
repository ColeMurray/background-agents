import { describe, expect, it, vi } from "vitest";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { createOpenInspectExtension, createSubagentExtension } from "./open-inspect-extension";

describe("createOpenInspectExtension", () => {
  it("offers replay-safe repository tools only when the session has repositories", async () => {
    const invokeRepository = vi.fn(async () => ({ entries: [] }));
    const extension = createOpenInspectExtension({
      repositories: [
        {
          repoOwner: "acme",
          repoName: "widgets",
          position: 0,
          baseBranch: "main",
          commitSha: "abc123",
        },
      ],
      invokeRepository,
    });

    expect(extension.tools?.map((tool) => [tool.name, tool.replay])).toEqual([
      ["repository_list", "safe"],
      ["repository_read", "safe"],
    ]);

    const list = extension.tools?.find((tool) => tool.name === "repository_list");
    const result = await list?.execute({ path: "src" }, { taskId: 17 } as ToolExecutionApi, {
      abortSignal: undefined,
      value: () => undefined,
      toString: () => "test",
    });
    expect(invokeRepository).toHaveBeenCalledWith(
      "repository_list",
      { path: "src", commitSha: "abc123" },
      undefined
    );
    expect(result).toMatchObject({ structuredOutput: { entries: [] } });
  });

  it("keeps repository-less sessions free of repository tools", () => {
    const extension = createOpenInspectExtension({
      repositories: [],
      invokeRepository: vi.fn(),
    });
    expect(extension.tools?.map((tool) => tool.name)).toEqual([]);
  });

  it("packages subagents separately so children retain the core Open-Inspect extension", () => {
    const extension = createSubagentExtension();
    expect(extension.name).toBe("open-inspect.subagent");
    expect(extension.tools?.map((tool) => [tool.name, tool.replay])).toEqual([
      ["subagent", "safe"],
    ]);
  });
});
