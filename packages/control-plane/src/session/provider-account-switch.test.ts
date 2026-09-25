import { describe, expect, it, vi } from "vitest";
import type { SessionModelProviderAuth } from "@open-inspect/shared/types/provider-accounts";
import type { ProviderAccountSwitchEvent } from "@open-inspect/shared/types/provider-account-switch";
import type { ProviderAccountSwitchCommand } from "@open-inspect/shared/types/provider-account-switch";
import { ProviderAccountSwitchCoordinator } from "./provider-account-switch";
import type { ProviderSwitchRecord } from "./provider-account-switch-repository";
import type { SandboxRow, SessionRow } from "./types";
import type { SandboxShutdownState } from "@open-inspect/shared/types/sandbox-shutdown";
import type { BindingSwitch } from "../db/session-provider-binding";

const generation = { sandboxId: "sandbox", createdAt: 100 };
const source = "a".repeat(32),
  target = "b".repeat(32);
const request = { operationId: "switch-1", targetAccountId: target, expectedBindingRevision: 1 };
function fixture() {
  let state: ProviderSwitchRecord = {
    operation: null,
    lastAppliedOperation: null,
    history: [],
    epoch: 0,
    capability: generation,
    supportedProviders: ["openai"],
  };
  let now = 1000;
  let binding: SessionModelProviderAuth = {
    provider: "openai",
    authMode: "provider_account",
    providerAccountId: source,
    bindingRevision: 1,
    selectionSource: "explicit",
  };
  const session = {
    status: "active",
    agent_session_id: "conversation",
    harness: "opencode",
    model: "openai/gpt-5",
  } as SessionRow;
  const sandbox = {
    modal_sandbox_id: generation.sandboxId,
    created_at: generation.createdAt,
    fenced: 0,
    status: "ready",
  } as SandboxRow;
  const deps = {
    store: {
      read: () => state,
      write: (next: ProviderSwitchRecord) => {
        state = next;
      },
    },
    session: () => session,
    sessionId: () => "session",
    sandbox: () => sandbox,
    pendingCount: () => 2,
    processing: () => true,
    canAdmit: () => true,
    enabled: vi.fn(() => true),
    claim: (_op: unknown, persist: () => void) => persist(),
    deliverAudit: vi.fn(async () => {}),
    owns: vi.fn(() => true),
    release: vi.fn(),
    preservation: vi.fn<() => SandboxShutdownState | null>(() => null),
    retain: vi.fn(async () => {}),
    inactivityMs: () => 600_000,
    canRestore: vi.fn(() => false),
    restore: vi.fn(async () => {}),
    index: {
      getCompleteProviderAuth: vi.fn(async () => [binding]),
      getProviderAuthForProvider: vi.fn(async () => binding),
    },
    bindings: {
      commit: vi.fn(async (input: BindingSwitch) => {
        binding = {
          ...binding,
          authMode: "provider_account",
          providerAccountId: target,
          bindingRevision: input.expectedBindingRevision + 1,
          lastSwitchOperationId: input.operationId,
        };
        return binding;
      }),
    },
    prepare: vi.fn(async () => {}),
    send: vi.fn((_command: ProviderAccountSwitchCommand) => true),
    schedule: vi.fn(async () => {}),
    changed: vi.fn(),
    pump: vi.fn(async () => {}),
    now: () => now,
  };
  const coordinator = new ProviderAccountSwitchCoordinator(deps);
  const event = (outcome: ProviderAccountSwitchEvent["outcome"]): ProviderAccountSwitchEvent => ({
    type: "provider_account_switch",
    operationId: request.operationId,
    provider: "openai",
    bindingRevision: 2,
    generation,
    conversationId: "conversation",
    outcome,
  });
  return {
    coordinator,
    deps,
    event,
    session,
    sandbox,
    expire: () => {
      now = 200_000;
    },
  };
}
describe("provider account switch ownership", () => {
  it("holds before the first await, commits only after containment, and requires explicit continuation", async () => {
    const { coordinator, deps, event } = fixture();
    const starting = coordinator.start("openai", request, "actor");
    expect(coordinator.held()).toBe(true);
    expect(deps.bindings.commit).not.toHaveBeenCalled();
    await starting;
    expect(deps.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: "openai/gpt-5", reasoningEffort: null })
    );
    await coordinator.event(event("quiesced"));
    expect(deps.bindings.commit).toHaveBeenCalledOnce();
    expect(coordinator.operation()?.phase).toBe("applying");
    await coordinator.event(event("applied"));
    expect(coordinator.held()).toBe(true);
    expect(deps.pump).not.toHaveBeenCalled();
    await coordinator.resume(request.operationId, 2);
    expect(coordinator.held()).toBe(false);
    expect(deps.pump).toHaveBeenCalledOnce();
    await coordinator.event(event("failed"));
    expect(coordinator.operation()?.phase).toBe("applied");
    expect(coordinator.held()).toBe(false);
  });
  it("ignores old generation, revision, conversation and operation acknowledgements", async () => {
    const { coordinator, deps, event } = fixture();
    await coordinator.start("openai", request, "actor");
    for (const patch of [
      { generation: { ...generation, createdAt: 1 } },
      { bindingRevision: 3 },
      { conversationId: "other" },
      { operationId: "other" },
    ])
      await coordinator.event({ ...event("quiesced"), ...patch });
    expect(deps.bindings.commit).not.toHaveBeenCalled();
    expect(coordinator.operation()?.phase).toBe("quiescing");
  });
  it("archive/cancel during preparation fences the continuation", async () => {
    const { coordinator, deps } = fixture();
    let complete!: () => void;
    deps.prepare.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        })
    );
    const starting = coordinator.start("openai", request, "actor");
    await vi.waitFor(() => expect(deps.prepare).toHaveBeenCalled());
    coordinator.cancel();
    complete();
    await starting;
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.bindings.commit).not.toHaveBeenCalled();
    expect(coordinator.operation()?.phase).toBe("cancelled");
  });
  it("failed delivery stays held and a same-intent retry re-establishes containment", async () => {
    const { coordinator, deps } = fixture();
    deps.send.mockReturnValueOnce(false);
    await coordinator.start("openai", request, "actor");
    expect(coordinator.operation()?.phase).toBe("needs_reconciliation");
    await coordinator.start("openai", request, "actor");
    expect(deps.send).toHaveBeenCalledTimes(2);
    expect(deps.send.mock.calls[1][0]).toMatchObject({ type: "provider_account_quiesce" });
    await expect(
      coordinator.start("openai", { ...request, targetAccountId: source }, "actor")
    ).rejects.toThrow("conflict");
  });
  it("reconnect re-quiesces even when the binding committed before local progress was saved", async () => {
    const { coordinator, deps, event } = fixture();
    await coordinator.start("openai", request, "actor");
    await coordinator.event(event("quiesced"));
    await coordinator.runtimeReady(["openai"]);
    expect(deps.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "provider_account_quiesce" })
    );
    expect(coordinator.held()).toBe(true);
  });
  it("expiry cannot release queued work or extend the absolute deadline", async () => {
    const { coordinator, deps, expire } = fixture();
    await coordinator.start("openai", request, "actor");
    const deadline = coordinator.operation()?.deadlineMs;
    expire();
    expect(await coordinator.alarm()).toBe("hold_watchdogs");
    await coordinator.start("openai", request, "actor");
    expect(coordinator.operation()).toMatchObject({
      hold: true,
      reason: "deadline_expired",
      deadlineMs: deadline,
    });
    expect(deps.send).toHaveBeenCalledOnce();
    expect(deps.pump).not.toHaveBeenCalled();
  });
  it("never admits an unqualified provider or old image", async () => {
    const { coordinator, deps, session } = fixture();
    session.model = "xai/grok";
    await expect(coordinator.start("xai", request, "actor")).rejects.toThrow("unsupported");
    session.model = "openai/gpt-5";
    await coordinator.runtimeReady([]);
    await expect(coordinator.start("openai", request, "actor")).rejects.toThrow("unsupported");
    expect(deps.prepare).not.toHaveBeenCalled();
    expect(coordinator.held()).toBe(false);
  });

  it("saved Continue creates a bounded reapplication with the current actor even when new switches are disabled", async () => {
    const { coordinator, deps, event } = fixture();
    await coordinator.start("openai", request, "original-actor");
    await coordinator.event(event("quiesced"));
    await coordinator.event(event("applied"));
    deps.preservation.mockReturnValue({ phase: "saved" } as SandboxShutdownState);
    deps.canRestore.mockReturnValue(true);
    deps.enabled.mockReturnValue(false);
    deps.owns.mockReturnValue(false);
    await coordinator.resume(request.operationId, 2, "current-actor");
    expect(coordinator.operation()).toMatchObject({
      phase: "restoring",
      hold: true,
      actorId: "current-actor",
      expectedBindingRevision: 2,
      bindingRevision: 3,
    });
    expect(coordinator.operation()?.operationId).not.toBe(request.operationId);
    expect(deps.prepare).toHaveBeenLastCalledWith("openai", target, "current-actor");
    expect(deps.restore).toHaveBeenCalledOnce();
    expect(deps.pump).not.toHaveBeenCalled();
  });

  it("ordinary idle restore claims a new hold before ready and reconciles after early-ready provider completion", async () => {
    const { coordinator, deps, event, sandbox } = fixture();
    await coordinator.start("openai", request, "actor");
    await coordinator.event(event("quiesced"));
    await coordinator.event(event("applied"));
    await coordinator.resume(request.operationId, 2, "actor");
    deps.send.mockClear();
    deps.pump.mockClear();
    sandbox.created_at = 200;
    const nextGeneration = { ...generation, createdAt: 200 };
    const owner = coordinator.generationReserved(
      { kind: "prompt", messageId: "next-prompt" },
      nextGeneration
    );
    expect(owner).toMatchObject({
      kind: "provider_switch",
      operationId: coordinator.operation()?.operationId,
    });
    expect(coordinator.held()).toBe(true);
    deps.owns.mockReturnValue(false); // runtime ready arrived before provider resume completed
    await coordinator.runtimeReady(["openai"]);
    expect(deps.send).not.toHaveBeenCalled();
    deps.owns.mockReturnValue(true);
    await coordinator.reconcile(); // lifecycle completion notification
    const op = coordinator.operation()!;
    expect(deps.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "provider_account_quiesce",
        generation: nextGeneration,
        bindingRevision: 3,
      })
    );
    const nextEvent = {
      ...event("quiesced"),
      generation: nextGeneration,
      operationId: op.operationId,
      bindingRevision: 3,
    };
    await coordinator.event(nextEvent);
    await coordinator.event({ ...nextEvent, outcome: "applied" });
    expect(coordinator.operation()).toMatchObject({ phase: "applied", hold: true });
    expect(deps.pump).not.toHaveBeenCalled();
    await coordinator.resume(op.operationId, 3, "actor");
    expect(coordinator.held()).toBe(false);
    expect(deps.pump).toHaveBeenCalledOnce();
  });

  it("retains the applied binding across rejected attempts, history eviction and coordinator restart", async () => {
    const { coordinator, deps, event, sandbox } = fixture();
    await coordinator.start("openai", request, "actor");
    await coordinator.event(event("quiesced"));
    await coordinator.event(event("applied"));
    await coordinator.resume(request.operationId, 2, "actor");
    deps.prepare.mockRejectedValue(new Error("Target credential unavailable"));
    for (let attempt = 0; attempt < 35; attempt++) {
      await expect(
        coordinator.start(
          "openai",
          {
            operationId: `rejected-${attempt}`,
            targetAccountId: source,
            expectedBindingRevision: 2,
          },
          "actor"
        )
      ).rejects.toThrow("unavailable");
    }
    expect(coordinator.operation()).toMatchObject({ phase: "failed", hold: false });
    expect(deps.store.read().history).toHaveLength(32);
    expect(deps.store.read().history.some((op) => op.phase === "applied")).toBe(false);
    expect(deps.store.read().lastAppliedOperation).toMatchObject({
      targetAccountId: target,
      bindingRevision: 2,
    });
    deps.prepare.mockResolvedValue();
    deps.send.mockClear();
    deps.pump.mockClear();
    const recovered = new ProviderAccountSwitchCoordinator(deps);
    const nextGeneration = { ...generation, createdAt: 200 };
    sandbox.created_at = 200;
    const owner = recovered.generationReserved(
      { kind: "prompt", messageId: "pending" },
      nextGeneration
    );
    expect(owner).toEqual({
      kind: "provider_switch",
      operationId: recovered.operation()?.operationId,
    });
    expect(recovered.operation()).toMatchObject({
      phase: "restoring",
      sourceAccountId: target,
      targetAccountId: target,
      expectedBindingRevision: 2,
      bindingRevision: 3,
      hold: true,
    });
    await recovered.runtimeReady(["openai"]);
    const nextEvent = {
      ...event("quiesced"),
      operationId: recovered.operation()!.operationId,
      generation: nextGeneration,
      bindingRevision: 3,
    };
    await recovered.event(nextEvent);
    await recovered.event({ ...nextEvent, outcome: "applied" });
    expect(recovered.operation()).toMatchObject({ phase: "applied", hold: true });
    expect(deps.pump).not.toHaveBeenCalled();
    await recovered.resume(nextEvent.operationId, 3, "actor");
    expect(deps.pump).toHaveBeenCalledOnce();
  });
});
