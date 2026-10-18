import { describe, expect, it, vi } from "vitest";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Workspace } from "@cloudflare/computer";

const computer = vi.hoisted(() => ({
  execute: vi.fn(),
  createPiTools: vi.fn(),
}));

vi.mock("@cloudflare/computer/tools/pi-ai", () => ({
  createPiTools: computer.createPiTools,
}));

import { createComputerWorkspaceExtension } from "./computer-workspace-extension";

const parameters = { type: "object", properties: { path: { type: "string" } } };

function declaredTool(
  name: string,
  constrainedSampling?: { type: "json_schema"; strict: "prefer" }
) {
  return {
    name,
    description: `${name} workspace files`,
    parameters,
    ...(constrainedSampling ? { constrainedSampling } : {}),
  };
}

function arrangeComputerTools() {
  computer.createPiTools.mockReturnValue({
    tools: [
      declaredTool("read", { type: "json_schema", strict: "prefer" }),
      declaredTool("ls"),
      declaredTool("find"),
      declaredTool("grep"),
      // A future Computer release must not widen the capability set merely by
      // returning another declaration despite readonly mode.
      declaredTool("write"),
    ],
    execute: computer.execute,
  });
}

const context = {
  abortSignal: new AbortController().signal,
  value: () => undefined,
  toString: () => "test",
};

describe("createComputerWorkspaceExtension", () => {
  it("exposes only bounded read-only workspace tools", () => {
    arrangeComputerTools();

    const extension = createComputerWorkspaceExtension({} as Workspace);

    expect(extension.name).toBe("open-inspect.workspace");
    expect(computer.createPiTools).toHaveBeenCalledWith({
      workspace: expect.anything(),
      root: "/workspace",
      readonly: true,
      exec: {},
      assets: false,
      constrainedSampling: "prefer",
    });
    expect(extension.tools?.map((tool) => [tool.name, tool.replay])).toEqual([
      ["read", "safe"],
      ["ls", "safe"],
      ["find", "safe"],
      ["grep", "safe"],
    ]);
    expect(extension.tools?.find((tool) => tool.name === "read")?.constrainedSampling).toEqual({
      type: "json_schema",
      strict: "prefer",
    });
  });

  it("maps Computer results onto the Pi Durable 1.3 output contract", async () => {
    arrangeComputerTools();
    computer.execute.mockResolvedValue({
      content: [{ type: "text", text: "notes" }],
      isError: false,
      details: { path: "/workspace/notes.md", count: 1 },
    });
    const extension = createComputerWorkspaceExtension({} as Workspace);
    const read = extension.tools?.find((tool) => tool.name === "read");
    const api = { callId: "call-7" } as ToolExecutionApi;

    await expect(read?.execute({ path: "notes.md" }, api, context)).resolves.toEqual({
      output: [{ type: "text", text: "notes" }],
      isError: false,
      details: { path: "/workspace/notes.md", count: 1 },
    });
    expect(computer.execute).toHaveBeenCalledWith(
      { id: "call-7", name: "read", arguments: { path: "notes.md" } },
      { abortSignal: context.abortSignal }
    );
  });

  it("describes the workspace as scratch rather than repository authority", () => {
    arrangeComputerTools();
    const extension = createComputerWorkspaceExtension({} as Workspace);
    const text = extension.sections?.[0]?.render({} as never, context);

    expect(text).toEqual(expect.stringContaining("durable session scratch space"));
    expect(text).toEqual(expect.stringContaining("repository_read"));
    expect(text).toEqual(expect.stringContaining("immutable pinned repository"));
  });
});
