import {
  PI_CODEMODE_TOOL_EFFECT_REGISTRATIONS,
  createToolEffectRegistry,
} from "@open-inspect/shared/pi-tool-effects";
import type { HookApi, ToolHookCall } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
  CODEMODE_MAX_QUEUED_CALLS,
  PiCodeModeExecutionCoordinator,
  createOpenInspectCodemodeExtension,
  createPiCodeModePolicyDelegate,
  createPiCodeModePolicyState,
} from "./codemode-extension";

const effects = createToolEffectRegistry([
  { name: "read", effect: "local_read", callers: ["tools"], replay: "safe" },
  { name: "write", effect: "local_mutation", callers: ["tools"], replay: "safe" },
  { name: "unstable", effect: "external_read", callers: ["tools"], replay: "unsafe" },
  ...PI_CODEMODE_TOOL_EFFECT_REGISTRATIONS,
]);
const context = { abortSignal: undefined, value: () => undefined, toString: () => "test" };

function call(name: string, parent?: { taskId: number; callId: string }): ToolHookCall {
  return {
    type: "toolCall",
    id: `call:${name}`,
    name,
    arguments: {},
    ...(parent ? { parent: { taskId: parent.taskId as never, callId: parent.callId } } : {}),
  };
}

describe("createOpenInspectCodemodeExtension", () => {
  it("installs the Code Mode tool and no model surface at all", () => {
    const sandbox = { start: () => undefined, close: async () => {} } as never;
    const extension = createOpenInspectCodemodeExtension(sandbox, createPiCodeModePolicyState());

    expect(extension.name).toBe("codemode");
    // The scripts get no model catalog and no model-call tools: those would
    // send model-written context to the provider with the session's
    // credential.
    expect(
      extension.tools?.map((tool) => [tool.name, tool.replay ?? "unsafe", tool.callers])
    ).toEqual(
      PI_CODEMODE_TOOL_EFFECT_REGISTRATIONS.filter((effect) => effect.name === "codemode").map(
        (effect) => [effect.name, effect.replay, effect.callers]
      )
    );
    expect(extension.tools?.map((tool) => tool.name)).not.toContain("pi.codemode.models.classify");
    expect(extension.tools?.map((tool) => tool.name)).not.toContain(
      "pi.codemode.models.generateImages"
    );
  });

  it("limits Code Mode nested calls to replay-safe reads of their own run", async () => {
    const state = createPiCodeModePolicyState();
    await state.parents.set(1 as never, "parent");
    const delegate = createPiCodeModePolicyDelegate(state);
    const api = {} as HookApi;

    await expect(
      delegate.beforeTool?.(
        call("read", { taskId: 1, callId: "parent" }),
        effects.get("read")!,
        api,
        context
      )
    ).resolves.toBeUndefined();
    await expect(
      delegate.beforeTool?.(
        call("write", { taskId: 1, callId: "parent" }),
        effects.get("write")!,
        api,
        context
      )
    ).resolves.toEqual({ block: "Code Mode may call only replay-safe read tools" });
    await expect(
      delegate.beforeTool?.(
        call("unstable", { taskId: 1, callId: "parent" }),
        effects.get("unstable")!,
        api,
        context
      )
    ).resolves.toEqual({ block: "Code Mode may call only replay-safe read tools" });
    // A nested call whose parentage cannot be proven is refused. The
    // rule that limits a script to replay-safe reads must not disappear when
    // the durable parent record is missing or does not match.
    await expect(
      delegate.beforeTool?.(
        call("write", { taskId: 2, callId: "parent" }),
        effects.get("write")!,
        api,
        context
      )
    ).resolves.toEqual({ block: "Code Mode may call only tools of its own run" });
    await expect(
      delegate.beforeTool?.(
        call("write", { taskId: 1, callId: "different-call" }),
        effects.get("write")!,
        api,
        context
      )
    ).resolves.toEqual({ block: "Code Mode may call only tools of its own run" });
  });

  it("serializes the whole session in FIFO order", async () => {
    const coordinator = new PiCodeModeExecutionCoordinator();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = coordinator.run(Date.now() + 1_000, undefined, async () => {
      order.push("first:start");
      await firstGate;
      order.push("first:end");
    });
    const second = coordinator.run(Date.now() + 1_000, undefined, async () => {
      order.push("second");
    });
    await Promise.resolve();
    expect(coordinator.snapshot()).toEqual({ active: true, queued: 1, closed: false });
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("removes aborted and expired queued calls without consuming the lane", async () => {
    const coordinator = new PiCodeModeExecutionCoordinator();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = coordinator.run(Date.now() + 1_000, undefined, () => firstGate);
    const abort = new AbortController();
    const aborted = coordinator.run(Date.now() + 1_000, abort.signal, async () => {});
    const expired = coordinator.run(Date.now() + 5, undefined, async () => {});
    abort.abort(new Error("cancelled"));

    await expect(aborted).rejects.toThrow("cancelled");
    await expect(expired).rejects.toThrow("absolute deadline expired");
    expect(coordinator.snapshot().queued).toBe(0);
    releaseFirst();
    await first;
  });

  it("rejects queued work and drains the active call during close", async () => {
    const coordinator = new PiCodeModeExecutionCoordinator();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = coordinator.run(Date.now() + 1_000, undefined, () => firstGate);
    const queued = coordinator.run(Date.now() + 1_000, undefined, async () => {});
    let drained = false;
    const close = coordinator.close(new Error("session deleted")).then(() => {
      drained = true;
    });

    await expect(queued).rejects.toThrow("session deleted");
    expect(drained).toBe(false);
    releaseFirst();
    await Promise.all([first, close]);
    expect(coordinator.snapshot()).toEqual({ active: false, queued: 0, closed: true });
  });

  it("bounds the session queue", async () => {
    const coordinator = new PiCodeModeExecutionCoordinator();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const deadline = Date.now() + 5_000;
    const first = coordinator.run(deadline, undefined, () => firstGate);
    const queued = Array.from({ length: CODEMODE_MAX_QUEUED_CALLS }, () =>
      coordinator.run(deadline, undefined, async () => {})
    );

    await expect(coordinator.run(deadline, undefined, async () => {})).rejects.toThrow(
      "Code Mode session queue is full"
    );
    expect(coordinator.snapshot().queued).toBe(CODEMODE_MAX_QUEUED_CALLS);
    releaseFirst();
    await Promise.all([first, ...queued]);
  });
});
