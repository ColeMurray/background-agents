import { describe, expect, it, vi } from "vitest";
import type { Context } from "@earendil-works/chord";
import type { HookApi, ToolExecutionResult, ToolHookCall } from "@earendil-works/pi-durable";
import {
  WORKSPACE_MUTATION_MAX_BYTES,
  createWorkspaceMutationPolicyExtension,
  createWorkspaceMutationPolicyHooks,
} from "./computer-workspace-policy";
import type { PiToolEffectMetadata } from "./tool-effects";

const context = {} as Context;

function call(name: string, args: Record<string, unknown>): ToolHookCall {
  return { type: "toolCall", id: `${name}-1`, name, arguments: args } as ToolHookCall;
}

function hookApi() {
  const memo = vi.fn(async (_name: string, candidate: unknown) => candidate);
  return { api: { memo } as unknown as HookApi, memo };
}

function effects(
  entries: Array<[tool: string, effect: PiToolEffectMetadata["effect"], operation?: string]>
): PiToolEffectMetadata[] {
  return entries.map(([tool, effect, operation = tool]) => ({
    tool,
    effect,
    owner: effect.startsWith("external_") ? "external-actions" : "workspace",
    operation,
  }));
}

describe("workspace mutation policy", () => {
  it("auto-allows a bounded scratch write and records metadata only", async () => {
    const hooks = createWorkspaceMutationPolicyHooks(
      effects([
        ["read", "local_read"],
        ["ls", "local_read"],
        ["find", "local_read"],
        ["grep", "local_read"],
        ["write", "local_mutation"],
        ["edit", "local_mutation"],
        ["delete", "local_mutation"],
      ])
    );
    const { api, memo } = hookApi();

    await expect(
      hooks.beforeTool(call("write", { path: "draft.txt", content: "private body" }), api, context)
    ).resolves.toBeUndefined();

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
    const hooks = createWorkspaceMutationPolicyHooks(effects([["edit", "local_mutation"]]));
    const { api, memo } = hookApi();
    const result = {
      output: [{ type: "text", text: "private diff" }],
      details: { diff: "private diff" },
      isError: false,
    } as ToolExecutionResult;

    await expect(
      hooks.afterTool(
        call("edit", {
          path: "/workspace/scratch/draft.txt",
          edits: [{ oldText: "private old", newText: "private new" }],
        }),
        result,
        api,
        context
      )
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

  it("blocks an unknown Computer mutation by default", async () => {
    const hooks = createWorkspaceMutationPolicyHooks(
      effects([
        ["read", "local_read"],
        ["rename", "unclassified"],
      ])
    );
    const { api, memo } = hookApi();

    await expect(
      hooks.beforeTool(call("rename", { from: "one.txt", to: "two.txt" }), api, context)
    ).resolves.toEqual({ block: "Workspace mutation is not allowed: rename" });
    expect(memo).toHaveBeenCalledWith(
      "open-inspect.workspace-policy.before",
      expect.objectContaining({ decision: "deny", tool: "rename" }),
      context
    );
  });

  it("blocks oversized content and paths outside scratch", async () => {
    const hooks = createWorkspaceMutationPolicyHooks(
      effects([
        ["write", "local_mutation"],
        ["delete", "local_mutation"],
      ])
    );
    const first = hookApi();
    const second = hookApi();

    await expect(
      hooks.beforeTool(
        call("write", {
          path: "large.txt",
          content: "x".repeat(WORKSPACE_MUTATION_MAX_BYTES + 1),
        }),
        first.api,
        context
      )
    ).resolves.toMatchObject({ block: expect.stringContaining("too large") });
    await expect(
      hooks.beforeTool(call("delete", { path: "../outside", recursive: true }), second.api, context)
    ).resolves.toMatchObject({ block: expect.stringContaining("outside /workspace/scratch") });
    await expect(
      hooks.beforeTool(
        call("write", { path: "/workspace/repos/0/file.txt", content: "repo" }),
        second.api,
        context
      )
    ).resolves.toMatchObject({ block: expect.stringContaining("outside /workspace/scratch") });
    expect(JSON.stringify([...first.memo.mock.calls, ...second.memo.mock.calls])).not.toContain(
      "xxx"
    );
  });

  it("does not apply the workspace policy to unrelated or external-effect tools", async () => {
    const hooks = createWorkspaceMutationPolicyHooks(
      effects([
        ["write", "local_mutation"],
        ["publish_pr", "external_mutation"],
      ])
    );
    const { api, memo } = hookApi();

    await expect(
      hooks.beforeTool(call("repository_read", { path: "README.md" }), api, context)
    ).resolves.toBeUndefined();
    await expect(
      hooks.beforeTool(call("publish_pr", { title: "external" }), api, context)
    ).resolves.toBeUndefined();
    expect(memo).not.toHaveBeenCalled();
  });

  it("installs mandatory ToolTask before and after hooks", () => {
    const extension = createWorkspaceMutationPolicyExtension(
      effects([
        ["write", "local_mutation"],
        ["edit", "local_mutation"],
        ["delete", "local_mutation"],
      ])
    );

    expect(extension.name).toBe("open-inspect.workspace-policy");
    expect(extension.hooks).toHaveLength(1);
    expect(extension.hooks?.[0]?.handlers).toEqual(
      expect.objectContaining({ beforeTool: expect.any(Function), afterTool: expect.any(Function) })
    );
  });
});
