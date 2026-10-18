import type { Workspace } from "@cloudflare/computer";
import type { Context } from "@earendil-works/chord";
import type { ToolEffectRegistration } from "@open-inspect/shared/pi-tool-effects";
import type {
  HookApi,
  ToolExecutionApi,
  ToolExecutionResult,
  ToolHookCall,
} from "@earendil-works/pi-durable";
import { beforeEach, describe, expect, it, vi } from "vitest";

const computer = vi.hoisted(() => ({
  scratchExecute: vi.fn(),
  repositoryExecute: vi.fn(),
  createPiTools: vi.fn(),
}));

vi.mock("@cloudflare/computer/tools/pi-ai", () => ({
  createPiTools: computer.createPiTools,
}));

import { createRepositoryEditingWorkspaceCapability } from "./repository-editing-capability";
import { WorkspaceMutationFifo } from "./computer-workspace-quota";
import type { PiRepositoryWorkspace } from "./repository-workspace";

const parameters = { type: "object", properties: { path: { type: "string" } } };
const context = {
  abortSignal: new AbortController().signal,
  value: () => undefined,
  toString: () => "test",
};

function declaredTool(name: string) {
  return { name, description: `${name} workspace files`, parameters };
}

function arrangeComputerTools() {
  computer.createPiTools
    .mockReturnValueOnce({
      tools: ["read", "ls", "find", "grep", "write", "edit", "delete"].map(declaredTool),
      execute: computer.scratchExecute,
    })
    .mockReturnValueOnce({
      tools: ["read", "ls", "find", "grep", "write", "edit", "delete"].map(declaredTool),
      execute: computer.repositoryExecute,
    });
}

function capability(
  scratchMode: "off" | "read_only" | "enabled",
  overlay: PiRepositoryWorkspace = {
    runMutation: vi.fn(async (_tool, _args, execute) => execute()),
  } as unknown as PiRepositoryWorkspace
) {
  return createRepositoryEditingWorkspaceCapability({
    scratchWorkspace: {} as Workspace,
    repositoryWorkspace: {} as Workspace,
    overlay,
    mutations: new WorkspaceMutationFifo(),
    scratchMode,
    publishDiff: vi.fn(async () => undefined),
    triggerMessageId: vi.fn(async () => null),
  });
}

function declaration(): ToolEffectRegistration {
  return { name: "write", effect: "local_mutation", callers: ["model"], replay: "unsafe" };
}

function call(path: string): ToolHookCall {
  return {
    type: "toolCall",
    id: "write-1",
    name: "write",
    arguments: { path, content: "private body" },
  } as ToolHookCall;
}

describe("repository editing workspace capability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    computer.scratchExecute.mockResolvedValue({ content: [], isError: false });
    computer.repositoryExecute.mockResolvedValue({ content: [], isError: false });
    arrangeComputerTools();
  });

  it("preserves true scratch-off behavior while repository reads remain available", async () => {
    const extension = capability("off").extension;
    const read = extension.tools?.find((tool) => tool.name === "read");

    await expect(
      read?.execute(
        { path: "/workspace/scratch/private.txt" },
        { callId: "scratch-read" } as ToolExecutionApi,
        context
      )
    ).resolves.toMatchObject({ isError: true });
    await expect(
      read?.execute(
        { path: "/workspace/repos/0/README.md" },
        { callId: "repository-read" } as ToolExecutionApi,
        context
      )
    ).resolves.toMatchObject({ isError: false });
    expect(computer.scratchExecute).not.toHaveBeenCalled();
    expect(computer.repositoryExecute).toHaveBeenCalledOnce();
  });

  it("rechecks cancellation after a repository mutation enters the shared FIFO", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const overlay = {
      runMutation: vi.fn(async (_tool, _args, execute: () => Promise<unknown>) => {
        await blocked;
        return execute();
      }),
    };
    const write = capability(
      "enabled",
      overlay as unknown as PiRepositoryWorkspace
    ).extension.tools?.find((tool) => tool.name === "write");
    const abort = new AbortController();
    const execution = write?.execute(
      { path: "/workspace/repos/0/file.txt", content: "body" },
      { callId: "repository-write" } as ToolExecutionApi,
      { ...context, abortSignal: abort.signal }
    );
    abort.abort();
    release();

    await expect(execution).resolves.toMatchObject({ isError: true });
    expect(computer.repositoryExecute).not.toHaveBeenCalled();
  });

  it("records metadata-only policy memos before and after repository mutations", async () => {
    const delegate = capability("off").toolPolicyDelegate;
    const memo = vi.fn(async (_name: string, value: unknown) => value);
    const api = { memo } as unknown as HookApi;
    const hookContext = {} as Context;
    const toolCall = call("/workspace/repos/0/private.txt");
    const result = { output: [], isError: false } as ToolExecutionResult;

    await expect(
      delegate.beforeTool?.(toolCall, declaration(), api, hookContext)
    ).resolves.toBeUndefined();
    expect(memo).not.toHaveBeenCalled();
    await delegate.memoFinalAllow?.(toolCall, declaration(), api, hookContext);
    await expect(
      delegate.afterTool?.(toolCall, declaration(), result, api, hookContext)
    ).resolves.toBe(result);
    expect(memo).toHaveBeenNthCalledWith(
      1,
      "open-inspect.repository-policy.before",
      {
        version: 1,
        scope: "repository",
        decision: "allow",
        tool: "write",
        path: "/workspace/repos/0/private.txt",
      },
      hookContext
    );
    expect(memo).toHaveBeenNthCalledWith(
      2,
      "open-inspect.repository-policy.after",
      {
        version: 1,
        scope: "repository",
        tool: "write",
        path: "/workspace/repos/0/private.txt",
        outcome: "succeeded",
      },
      hookContext
    );
    expect(JSON.stringify(memo.mock.calls)).not.toContain("private body");
  });
});
