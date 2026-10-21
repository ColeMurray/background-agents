import type { Context } from "@earendil-works/chord";
import type { ToolEffectKind, ToolEffectRegistration } from "@open-inspect/shared/pi-tool-effects";
import type { HookApi, ToolExecutionResult, ToolHookCall } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_MUTATION_MAX_BYTES,
  createWorkspaceMutationPolicyDelegate,
} from "./computer-workspace-policy";

const context = {} as Context;

function call(name: string, args: Record<string, unknown>): ToolHookCall {
  return { type: "toolCall", id: `${name}-1`, name, arguments: args } as ToolHookCall;
}

function declaration(name: string, effect: ToolEffectKind): ToolEffectRegistration {
  return {
    name,
    effect,
    callers: ["model", "tools"],
    replay: effect === "local_mutation" ? "unsafe" : "safe",
  };
}

function hookApi() {
  const memo = vi.fn(async (_name: string, candidate: unknown) => candidate);
  return { api: { memo } as unknown as HookApi, memo };
}

describe("workspace mutation policy delegate", () => {
  it("auto-allows a bounded scratch write and records metadata only", async () => {
    const delegate = createWorkspaceMutationPolicyDelegate();
    const { api, memo } = hookApi();
    const toolCall = call("write", { path: "draft.txt", content: "private body" });

    await expect(
      delegate.beforeTool?.(toolCall, declaration("write", "local_mutation"), api, context)
    ).resolves.toBeUndefined();
    expect(memo).not.toHaveBeenCalled();
    await delegate.memoFinalAllow?.(toolCall, declaration("write", "local_mutation"), api, context);
    expect(memo).toHaveBeenCalledWith(
      "open-inspect.workspace-policy.before",
      {
        version: 1,
        scope: "scratch",
        decision: "allow",
        tool: "write",
        path: "/workspace/scratch/draft.txt",
        contentBytes: 12,
      },
      context
    );
    expect(JSON.stringify(memo.mock.calls)).not.toContain("private body");
  });

  it("records a metadata-only outcome without changing the tool result", async () => {
    const delegate = createWorkspaceMutationPolicyDelegate();
    const { api, memo } = hookApi();
    const toolCall = call("edit", {
      path: "/workspace/scratch/draft.txt",
      edits: [{ oldText: "private old", newText: "private new" }],
    });
    const result = {
      output: [{ type: "text", text: "private diff" }],
      details: { diff: "private diff" },
      isError: false,
    } as ToolExecutionResult;

    await expect(
      delegate.afterTool?.(toolCall, declaration("edit", "local_mutation"), result, api, context)
    ).resolves.toBe(result);
    expect(memo).toHaveBeenCalledWith(
      "open-inspect.workspace-policy.after",
      {
        version: 1,
        scope: "scratch",
        tool: "edit",
        path: "/workspace/scratch/draft.txt",
        outcome: "succeeded",
      },
      context
    );
    expect(JSON.stringify(memo.mock.calls)).not.toContain("private");
  });

  it("blocks oversized content and paths outside scratch", async () => {
    const delegate = createWorkspaceMutationPolicyDelegate();
    const first = hookApi();
    const second = hookApi();

    await expect(
      delegate.beforeTool?.(
        call("write", {
          path: "large.txt",
          content: "x".repeat(WORKSPACE_MUTATION_MAX_BYTES + 1),
        }),
        declaration("write", "local_mutation"),
        first.api,
        context
      )
    ).resolves.toMatchObject({ block: expect.stringContaining("too large") });
    await expect(
      delegate.beforeTool?.(
        call("delete", { path: "../outside", recursive: true }),
        declaration("delete", "local_mutation"),
        second.api,
        context
      )
    ).resolves.toMatchObject({ block: expect.stringContaining("outside /workspace/scratch") });
  });

  it("leaves repository overlays and external effects to their own delegates", async () => {
    const delegate = createWorkspaceMutationPolicyDelegate();
    const { api, memo } = hookApi();

    await expect(
      delegate.beforeTool?.(
        call("write", { path: "/workspace/repos/0/file.txt", content: "repo" }),
        declaration("write", "local_mutation"),
        api,
        context
      )
    ).resolves.toBeUndefined();
    await expect(
      delegate.beforeTool?.(
        call("publish_pr", { title: "external" }),
        declaration("publish_pr", "external_mutation"),
        api,
        context
      )
    ).resolves.toBeUndefined();
    expect(memo).not.toHaveBeenCalled();
  });

  it("contributes optional before and after hooks to the composite policy", () => {
    expect(createWorkspaceMutationPolicyDelegate()).toEqual(
      expect.objectContaining({
        beforeTool: expect.any(Function),
        memoFinalAllow: expect.any(Function),
        afterTool: expect.any(Function),
      })
    );
  });
});
