import { describe, expect, it, vi } from "vitest";
import type { ExternalActionStatusResponse } from "@open-inspect/shared";
import {
  createToolEffectRegistry,
  type ToolEffectKind,
  type ToolEffectRegistration,
} from "@open-inspect/shared/pi-tool-effects";
import { createExternalActionPolicyDelegate } from "./external-action-policy-extension";
import { createPiToolPolicyExtension } from "./tool-policy-extension";

const action = {
  id: "action-1",
  sessionId: "session-1",
  operationId: "message-1",
  toolCallId: "call-1",
  idempotencyKey: "pi:call-1",
  provider: "fake",
  action: "publish_comment",
  summary: "Publish comment",
  target: {},
  arguments: {},
  fingerprint: "sha256:abc",
  state: "awaiting_approval" as const,
  approval: null,
  providerReference: null,
  publicResult: null,
  error: null,
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  expiresAt: null,
};

function status(state: typeof action.state | "approved" | "succeeded" | "indeterminate") {
  return { action: { ...action, state }, history: [] } as ExternalActionStatusResponse;
}

function hookHarness(
  initial: ExternalActionStatusResponse,
  admission?: () => Promise<{ allowed: boolean; reason?: string } | undefined>
) {
  const memos = new Map<string, unknown>();
  let current = initial;
  const client = {
    prepare: vi.fn(async () => current),
    status: vi.fn(async () => current),
    execute: vi.fn(async () => current),
  };
  const effects = createToolEffectRegistry([
    registration("repository_read", "external_read"),
    registration("remote_lookup", "external_read"),
    registration("local_write", "local_mutation"),
    registration("run_code", "sandbox_execution"),
    registration("publish_comment", "external_mutation"),
    registration("message_session", "external_mutation"),
  ]);
  const delegate = createExternalActionPolicyDelegate({
    client,
    authorizeNewEffect: admission,
    externalActions: {
      publish_comment: (call) => ({
        toolCallId: call.id,
        idempotencyKey: `pi:${call.id}`,
        provider: "fake",
        action: "publish_comment",
        summary: "Publish comment",
        target: {},
        arguments: JSON.parse(JSON.stringify(call.arguments)),
      }),
    },
  });
  const extension = createPiToolPolicyExtension(effects, [delegate]);
  const handlers = extension.hooks?.[0]?.handlers as {
    beforeTool: (
      call: never,
      api: never,
      context: never
    ) => Promise<{ block?: string } | undefined>;
    afterTool: (call: never, result: never, api: never, context: never) => Promise<unknown>;
  };
  const api = {
    memo: vi.fn(async (...args: [string, ...unknown[]]) => {
      const [name, candidate] = args;
      if (args.length === 3 && !memos.has(name)) memos.set(name, candidate);
      return memos.get(name);
    }),
  };
  return {
    handlers,
    api,
    client,
    setStatus(next: ExternalActionStatusResponse) {
      current = next;
    },
  };
}

describe("external action policy extension", () => {
  it("leaves an external mutation it does not own to the delegate that owns it", async () => {
    const h = hookHarness(status("awaiting_approval"));

    // `message_session` is an external mutation, but it belongs to the
    // cross-session delegate. Claiming it here would silently disable
    // cross-session messaging for every session.
    await expect(
      h.handlers.beforeTool(
        { id: "call-1", name: "message_session", arguments: {} } as never,
        h.api as never,
        {} as never
      )
    ).resolves.toBeUndefined();
    expect(h.client.prepare).not.toHaveBeenCalled();
  });

  it("uses the canonical composite registry to default-deny unknown tools", async () => {
    const h = hookHarness(status("awaiting_approval"));

    for (const name of ["repository_read", "remote_lookup"]) {
      await expect(
        h.handlers.beforeTool(
          { id: `call-${name}`, name, arguments: {} } as never,
          h.api as never,
          {} as never
        )
      ).resolves.toBeUndefined();
    }
    for (const name of ["local_write", "run_code"]) {
      await expect(
        h.handlers.beforeTool(
          { id: `call-${name}`, name, arguments: {} } as never,
          h.api as never,
          {} as never
        )
      ).resolves.toBeUndefined();
    }
    await expect(
      h.handlers.beforeTool(
        { id: "call-unknown", name: "unclassified_local_tool", arguments: {} } as never,
        h.api as never,
        {} as never
      )
    ).resolves.toEqual({ block: "Pi tool is not declared: unclassified_local_tool" });
    expect(h.client.prepare).not.toHaveBeenCalled();
  });

  it("persists the prepared action identity before blocking the terminal tool task", async () => {
    const h = hookHarness(status("awaiting_approval"));
    const call = { id: "call-1", name: "publish_comment", arguments: { body: "hello" } };

    await expect(
      h.handlers.beforeTool(call as never, h.api as never, {} as never)
    ).resolves.toEqual({ block: "External action is awaiting approval (action-1)" });
    expect(h.client.prepare).toHaveBeenCalledOnce();
    expect(h.client.status).not.toHaveBeenCalled();
    expect(h.api.memo).toHaveBeenCalledWith(
      "open-inspect:external-action:call-1",
      { schema: "open-inspect.external-action-policy.v1", actionId: "action-1" },
      {}
    );
  });

  it("allows a new call when SessionDO binds it to an exact approved action", async () => {
    const h = hookHarness(status("approved"));
    const call = { id: "continuation-call", name: "publish_comment", arguments: { body: "hello" } };

    await expect(
      h.handlers.beforeTool(call as never, h.api as never, {} as never)
    ).resolves.toBeUndefined();
    expect(h.client.prepare).toHaveBeenCalledOnce();
  });

  it("refuses a new effect when the live deployment policy denies it", async () => {
    const h = hookHarness(status("awaiting_approval"), async () => ({
      allowed: false,
      reason: "External actions are disabled for new effects by deployment policy",
    }));
    const call = { id: "call-denied", name: "publish_comment", arguments: { body: "hello" } };

    await expect(
      h.handlers.beforeTool(call as never, h.api as never, {} as never)
    ).resolves.toEqual({
      block: "External actions are disabled for new effects by deployment policy",
    });
    // Nothing was prepared, so a denied deployment leaves no effect behind.
    expect(h.client.prepare).not.toHaveBeenCalled();
  });

  it("keeps an already prepared effect reachable when the live policy denies new effects", async () => {
    let allowed = true;
    const h = hookHarness(status("awaiting_approval"), async () =>
      allowed ? { allowed: true } : { allowed: false, reason: "denied" }
    );
    const call = { id: "call-1", name: "publish_comment", arguments: { body: "hello" } };
    await h.handlers.beforeTool(call as never, h.api as never, {} as never);
    h.setStatus(status("approved"));
    allowed = false;

    await expect(
      h.handlers.beforeTool(call as never, h.api as never, {} as never)
    ).resolves.toBeUndefined();
    expect(h.client.status).toHaveBeenCalledWith("action-1", undefined);
    expect(h.client.prepare).toHaveBeenCalledOnce();
  });

  it("replaces a successful-looking tool result when publication is indeterminate", async () => {
    const h = hookHarness(status("approved"));
    const call = { id: "call-1", name: "publish_comment", arguments: {} };
    await h.handlers.beforeTool(call as never, h.api as never, {} as never);
    h.setStatus(status("indeterminate"));

    await expect(
      h.handlers.afterTool(
        call as never,
        { output: [{ type: "text", text: "published" }] } as never,
        h.api as never,
        {} as never
      )
    ).resolves.toMatchObject({
      isError: true,
      output: [{ type: "text", text: expect.stringContaining("indeterminate") }],
    });
  });

  it("fails closed when post-execution status cannot be confirmed", async () => {
    const h = hookHarness(status("approved"));
    const call = { id: "call-1", name: "publish_comment", arguments: {} };
    await h.handlers.beforeTool(call as never, h.api as never, {} as never);
    h.client.status.mockRejectedValueOnce(new Error("SessionDO unavailable"));

    await expect(
      h.handlers.afterTool(
        call as never,
        { output: [{ type: "text", text: "published" }] } as never,
        h.api as never,
        {} as never
      )
    ).resolves.toMatchObject({
      isError: true,
      output: [{ type: "text", text: expect.stringContaining("could not be confirmed") }],
    });
  });
});

function registration(name: string, effect: ToolEffectKind): ToolEffectRegistration {
  return { name, effect, callers: ["model", "tools"], replay: "safe" };
}
