import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Workspace } from "@cloudflare/computer";

const computer = vi.hoisted(() => ({
  execute: vi.fn(),
  createPiTools: vi.fn(),
}));

vi.mock("@cloudflare/computer/tools/pi-ai", () => ({
  createPiTools: computer.createPiTools,
}));

import { createComputerWorkspaceCapability } from "./computer-workspace-extension";
import { WorkspaceMutationFifo } from "./computer-workspace-quota";

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
      declaredTool("edit"),
      declaredTool("delete"),
      declaredTool("exec"),
    ],
    execute: computer.execute,
  });
}

const context = {
  abortSignal: new AbortController().signal,
  value: () => undefined,
  toString: () => "test",
};

function createExtension(mode: "read_only" | "enabled", mutations?: WorkspaceMutationFifo) {
  return createComputerWorkspaceCapability({} as Workspace, mode, mutations).extension;
}

describe("createComputerWorkspaceCapability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes only bounded read-only workspace tools", () => {
    arrangeComputerTools();

    const extension = createExtension("read_only");

    expect(extension.name).toBe("open-inspect.scratch-workspace");
    expect(computer.createPiTools).toHaveBeenCalledWith({
      workspace: expect.anything(),
      root: "/workspace/scratch",
      readonly: true,
      exec: {},
      assets: false,
      write: { maxBytes: 2 * 1024 * 1024 },
      edit: { maxBytes: 2 * 1024 * 1024 },
      constrainedSampling: "prefer",
    });
    expect(extension.tools?.map((tool) => [tool.name, tool.replay])).toEqual([
      ["read", "safe"],
      ["ls", "safe"],
      ["find", "safe"],
      ["grep", "safe"],
    ]);
    expect(extension.tools?.map((tool) => tool.callers)).toEqual([
      ["model", "tools"],
      ["model", "tools"],
      ["model", "tools"],
      ["model", "tools"],
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
      details: { path: "/workspace/scratch/notes.md", count: 1 },
    });
    const extension = createExtension("read_only");
    const read = extension.tools?.find((tool) => tool.name === "read");
    const api = { callId: "call-7" } as ToolExecutionApi;

    await expect(read?.execute({ path: "notes.md" }, api, context)).resolves.toEqual({
      output: [{ type: "text", text: "notes" }],
      isError: false,
      details: { path: "/workspace/scratch/notes.md", count: 1 },
    });
    expect(computer.execute).toHaveBeenCalledWith(
      { id: "call-7", name: "read", arguments: { path: "notes.md" } },
      { abortSignal: context.abortSignal }
    );
  });

  it("strips undefined fields from a committed truncated edit result", async () => {
    arrangeComputerTools();
    computer.execute.mockResolvedValue({
      content: [{ type: "text", text: "Edit applied; diff omitted" }],
      isError: false,
      details: {
        path: "/workspace/scratch/large.txt",
        firstChangedLine: 1,
        diff: undefined,
        patch: undefined,
        diffTruncated: true,
      },
    });
    const extension = createExtension("enabled");
    const edit = extension.tools?.find((tool) => tool.name === "edit");

    await expect(
      edit?.execute(
        { path: "large.txt", edits: [{ oldText: "old", newText: "new" }] },
        { callId: "edit-large" } as ToolExecutionApi,
        context
      )
    ).resolves.toEqual({
      output: [{ type: "text", text: "Edit applied; diff omitted" }],
      isError: false,
      details: {
        path: "/workspace/scratch/large.txt",
        firstChangedLine: 1,
        diffTruncated: true,
        // The write keeps the attribution of the turn that caused it.
        scratchCallId: "edit-large",
      },
    });
  });

  it("describes the workspace as scratch rather than repository authority", () => {
    arrangeComputerTools();
    const extension = createExtension("read_only");
    const text = extension.sections?.[0]?.render({} as never, context);

    expect(text).toEqual(expect.stringContaining("durable session scratch space"));
    expect(text).toEqual(expect.stringContaining("/workspace/scratch"));
    expect(text).toEqual(expect.stringContaining("repository_read"));
    expect(text).toEqual(expect.stringContaining("immutable pinned repository"));
  });

  it("exposes write, edit, and delete as unsafe sequential tools in writable mode", () => {
    arrangeComputerTools();

    const extension = createExtension("enabled");

    expect(computer.createPiTools).toHaveBeenCalledWith({
      workspace: expect.anything(),
      root: "/workspace/scratch",
      readonly: false,
      exec: {},
      assets: false,
      write: { maxBytes: 2 * 1024 * 1024 },
      edit: { maxBytes: 2 * 1024 * 1024 },
      constrainedSampling: "prefer",
    });
    expect(extension.tools?.map((tool) => [tool.name, tool.replay, tool.executionMode])).toEqual([
      ["read", "safe", undefined],
      ["ls", "safe", undefined],
      ["find", "safe", undefined],
      ["grep", "safe", undefined],
      ["write", "unsafe", "sequential"],
      ["edit", "unsafe", "sequential"],
      ["delete", "unsafe", "sequential"],
    ]);
  });

  it("exports canonical effects and a scratch policy contribution", () => {
    arrangeComputerTools();

    const capability = createComputerWorkspaceCapability({} as Workspace, "enabled");

    expect(capability.extension.name).toBe("open-inspect.scratch-workspace");
    expect(capability.toolPolicyDelegate).toEqual(
      expect.objectContaining({ beforeTool: expect.any(Function), afterTool: expect.any(Function) })
    );
    expect(capability.effects).toEqual([
      { name: "read", effect: "local_read", callers: ["model", "tools"], replay: "safe" },
      { name: "ls", effect: "local_read", callers: ["model", "tools"], replay: "safe" },
      { name: "find", effect: "local_read", callers: ["model", "tools"], replay: "safe" },
      { name: "grep", effect: "local_read", callers: ["model", "tools"], replay: "safe" },
      { name: "write", effect: "local_mutation", callers: ["model", "tools"], replay: "unsafe" },
      { name: "edit", effect: "local_mutation", callers: ["model", "tools"], replay: "unsafe" },
      { name: "delete", effect: "local_mutation", callers: ["model", "tools"], replay: "unsafe" },
    ]);
  });

  it("serializes all writable tools through one FIFO", async () => {
    arrangeComputerTools();
    let resolveFirst: ((value: { content: never[]; isError: false }) => void) | undefined;
    const first = new Promise<{ content: never[]; isError: false }>((resolve) => {
      resolveFirst = resolve;
    });
    computer.execute
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce({ content: [], isError: false });
    const extension = createExtension("enabled", new WorkspaceMutationFifo());
    const write = extension.tools?.find((tool) => tool.name === "write");
    const remove = extension.tools?.find((tool) => tool.name === "delete");

    const writing = write?.execute(
      { path: "one.txt", content: "one" },
      { callId: "write-1" } as ToolExecutionApi,
      context
    );
    const deleting = remove?.execute(
      { path: "two.txt" },
      { callId: "delete-1" } as ToolExecutionApi,
      context
    );
    await vi.waitFor(() => expect(computer.execute).toHaveBeenCalledTimes(1));

    resolveFirst?.({ content: [], isError: false });
    await Promise.all([writing, deleting]);

    expect(computer.execute.mock.calls.map(([call]) => call.name)).toEqual(["write", "delete"]);
  });

  it("does not start a queued mutation after its tool context is aborted", async () => {
    arrangeComputerTools();
    let resolveFirst: ((value: { content: never[]; isError: false }) => void) | undefined;
    const first = new Promise<{ content: never[]; isError: false }>((resolve) => {
      resolveFirst = resolve;
    });
    computer.execute.mockImplementationOnce(() => first);
    const extension = createExtension("enabled", new WorkspaceMutationFifo());
    const write = extension.tools?.find((tool) => tool.name === "write");
    const remove = extension.tools?.find((tool) => tool.name === "delete");
    const abort = new AbortController();

    const writing = write?.execute(
      { path: "one.txt", content: "one" },
      { callId: "write-1" } as ToolExecutionApi,
      context
    );
    const deleting = remove?.execute(
      { path: "two.txt" },
      { callId: "delete-1" } as ToolExecutionApi,
      { ...context, abortSignal: abort.signal }
    );
    abort.abort();
    resolveFirst?.({ content: [], isError: false });

    await writing;
    await expect(deleting).resolves.toMatchObject({ isError: true });
    expect(computer.execute).toHaveBeenCalledTimes(1);
  });

  it("reports an in-flight aborted mutation as indeterminate after reconciliation", async () => {
    arrangeComputerTools();
    let release!: () => void;
    const paused = new Promise<void>((resolve) => (release = resolve));
    computer.execute.mockImplementationOnce(async () => {
      await paused;
      return { content: [{ type: "text", text: "written" }], isError: false };
    });
    const extension = createExtension("enabled", new WorkspaceMutationFifo());
    const write = extension.tools?.find((tool) => tool.name === "write");
    const abort = new AbortController();

    const result = write?.execute(
      { path: "paused.txt", content: "body" },
      { callId: "write-paused" } as ToolExecutionApi,
      { ...context, abortSignal: abort.signal }
    );
    await vi.waitFor(() => expect(computer.execute).toHaveBeenCalledOnce());
    abort.abort();
    release();

    await expect(result).resolves.toMatchObject({
      isError: true,
      output: [
        expect.objectContaining({ text: expect.stringMatching(/indeterminate.*reconciled/i) }),
      ],
    });
  });

  it("reports an in-flight aborted delete as indeterminate after reconciliation", async () => {
    arrangeComputerTools();
    let release!: () => void;
    const paused = new Promise<void>((resolve) => (release = resolve));
    computer.execute.mockImplementationOnce(async () => {
      await paused;
      return { content: [{ type: "text", text: "deleted" }], isError: false };
    });
    const extension = createExtension("enabled", new WorkspaceMutationFifo());
    const remove = extension.tools?.find((tool) => tool.name === "delete");
    const abort = new AbortController();
    const result = remove?.execute(
      { path: "paused.txt" },
      { callId: "delete-paused" } as ToolExecutionApi,
      { ...context, abortSignal: abort.signal }
    );
    await vi.waitFor(() => expect(computer.execute).toHaveBeenCalledOnce());
    abort.abort();
    release();

    await expect(result).resolves.toMatchObject({
      isError: true,
      output: [
        expect.objectContaining({ text: expect.stringMatching(/indeterminate.*reconciled/i) }),
      ],
    });
  });

  it.each([
    "/workspace",
    "/workspace/",
    "/workspace/child/..",
    "/workspace/scratch",
    "/workspace/scratch/",
    ".",
    "./",
    "child/..",
  ])("refuses deletion of the workspace root expressed as %s", async (path) => {
    arrangeComputerTools();
    const extension = createExtension("enabled");
    const remove = extension.tools?.find((tool) => tool.name === "delete");

    await expect(
      remove?.execute(
        { path, recursive: true },
        { callId: "delete-root" } as ToolExecutionApi,
        context
      )
    ).resolves.toMatchObject({ isError: true });
    expect(computer.execute).not.toHaveBeenCalled();
  });
});
