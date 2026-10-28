import { describe, expect, it, vi } from "vitest";
import type { SandboxPushAdmission } from "../sandbox/lifecycle/manager";
import type { GitPushSpec } from "../source-control";
import type { SandboxCommandOutbox } from "./sandbox-command-outbox";
import { SandboxPushService } from "./sandbox-push-service";
import type { SandboxCommandTarget, SessionWebSocketManager } from "./websocket-manager";

function createPushSpec(repoOwner: string, repoName: string, targetBranch: string): GitPushSpec {
  return {
    remoteUrl: `https://token@example.com/${repoOwner}/${repoName}.git`,
    redactedRemoteUrl: `https://***@example.com/${repoOwner}/${repoName}.git`,
    refspec: `HEAD:refs/heads/${targetBranch}`,
    targetBranch,
    repoOwner,
    repoName,
    force: false,
  };
}

function createService(admission: () => SandboxPushAdmission = () => "unmanaged") {
  const sandboxWs = { readyState: WebSocket.OPEN } as WebSocket;
  const wsManager = {
    getSandboxSocket: vi.fn(() => sandboxWs as WebSocket | null),
    getSandboxCommandTarget: vi.fn((): SandboxCommandTarget => ({
      kind: "dispatch",
      socket: sandboxWs,
    })),
    send: vi.fn((_ws?: unknown, _command?: unknown) => true),
  };
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  const commands = {
    sendPush: vi.fn<SandboxCommandOutbox["sendPush"]>(async (ws, command, commandId) =>
      wsManager.send(ws, { ...command, commandId })
    ),
    discard: vi.fn(),
  };
  const service = new SandboxPushService(
    log,
    wsManager as unknown as SessionWebSocketManager,
    commands,
    admission
  );
  return { service, wsManager, commands, log };
}

describe("SandboxPushService", () => {
  it("assumes a manual push when no sandbox is attached at all", async () => {
    const h = createService();
    h.wsManager.getSandboxSocket.mockReturnValue(null);
    h.wsManager.getSandboxCommandTarget.mockReturnValue({ kind: "unavailable" });

    const result = await h.service.pushBranchToRemote(createPushSpec("acme", "web", "feature/x"));

    expect(result).toEqual({ success: true });
    expect(h.wsManager.send).not.toHaveBeenCalled();
    expect(h.log.info).toHaveBeenCalledWith(
      "No sandbox connected, assuming branch was pushed manually"
    );
  });

  it("rejects a saved managed sandbox instead of assuming a manual push", async () => {
    const h = createService(() => "start_required");
    h.wsManager.getSandboxCommandTarget.mockReturnValue({ kind: "unavailable" });

    const result = await h.service.pushBranchToRemote(createPushSpec("acme", "web", "feature/x"));

    expect(result).toEqual({
      success: false,
      error: "Sandbox must be started before pushing; retry once ready",
    });
    expect(h.wsManager.send).not.toHaveBeenCalled();
  });

  it.each(["confirmed", "legacy"] as const)(
    "does not fake a %s managed push while its ready runtime is disconnected",
    async (lifecyclePolicy) => {
      const h = createService(() => "ready");
      h.wsManager.getSandboxCommandTarget.mockReturnValue({ kind: "unavailable" });

      const result = await h.service.pushBranchToRemote(
        createPushSpec("acme", "web", `feature/${lifecyclePolicy}`)
      );

      expect(result).toEqual({
        success: false,
        error: "Sandbox is disconnected; retry once it is ready",
      });
      expect(h.wsManager.send).not.toHaveBeenCalled();
    }
  );

  it("pushes through an acknowledged live managed sandbox", async () => {
    const h = createService(() => "ready");

    const pushing = h.service.pushBranchToRemote(createPushSpec("acme", "web", "feature/live"));
    h.service.settlePush({
      type: "push_complete",
      branchName: "feature/live",
      repoOwner: "acme",
      repoName: "web",
      timestamp: 1_000,
    });

    await expect(pushing).resolves.toEqual({ success: true });
    expect(h.wsManager.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "push" })
    );
  });

  it("queues a push through the outbox while the sandbox target is reconnecting", async () => {
    vi.useFakeTimers();
    try {
      const h = createService(() => "ready");
      const socket = h.wsManager.getSandboxSocket()!;
      h.wsManager.getSandboxCommandTarget.mockReturnValue({ kind: "reconnecting", socket });
      h.commands.sendPush.mockResolvedValueOnce(true);
      const pushSpec = createPushSpec("acme", "web", "feature/queued");
      const result = vi.fn();
      const pushing = h.service.pushBranchToRemote(pushSpec).then(result);
      const [, , commandId, expiresAt] = h.commands.sendPush.mock.calls[0];
      await vi.advanceTimersByTimeAsync(0);

      expect(h.commands.sendPush).toHaveBeenCalledWith(
        socket,
        { type: "push", pushSpec },
        expect.any(String),
        expect.any(Number)
      );
      expect(expiresAt).toBeGreaterThan(Date.now());
      expect(h.wsManager.send).not.toHaveBeenCalled();
      expect(result).not.toHaveBeenCalled();

      h.service.settlePush({ type: "push_complete", commandId, timestamp: 1000 });
      await pushing;
      expect(result).toHaveBeenCalledWith({ success: true });
      expect(h.commands.discard).toHaveBeenCalledWith(commandId);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each([
    ["held", "Sandbox graceful shutdown is in progress; push is held"],
    ["start_required", "Sandbox must be started before pushing; retry once ready"],
  ] as const)("rejects %s admission before socket fallback", async (admission, error) => {
    const h = createService(() => admission);
    h.wsManager.getSandboxCommandTarget.mockReturnValue({ kind: "unavailable" });

    const result = await h.service.pushBranchToRemote(
      createPushSpec("acme", "web", `feature/${admission}`)
    );

    expect(result).toEqual({ success: false, error });
    expect(h.wsManager.getSandboxCommandTarget).not.toHaveBeenCalled();
    expect(h.wsManager.send).not.toHaveBeenCalled();
  });

  it("refuses, rather than fakes, a push while the attached sandbox is still booting", async () => {
    // A bridge attached ahead of its boot has no repository to push from. The
    // manual-push assumption would let a PR be opened on a branch that was
    // never pushed; the caller must retry once the sandbox is ready.
    const h = createService();
    h.wsManager.getSandboxCommandTarget.mockReturnValue({ kind: "booting", phase: null });

    const result = await h.service.pushBranchToRemote(createPushSpec("acme", "web", "feature/x"));

    expect(result).toEqual({
      success: false,
      error: "Sandbox is still starting; retry once it is ready",
    });
    expect(h.wsManager.send).not.toHaveBeenCalled();
  });

  it("fails a push immediately when the command cannot be delivered", async () => {
    vi.useFakeTimers();
    try {
      const h = createService();
      h.wsManager.send.mockReturnValue(false);

      let result: Awaited<ReturnType<typeof h.service.pushBranchToRemote>> | undefined;
      void h.service
        .pushBranchToRemote(createPushSpec("acme", "web", "feature/test"))
        .then((pushResult) => {
          result = pushResult;
        });
      await vi.advanceTimersByTimeAsync(0);

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining("Failed to deliver push command to sandbox"),
      });
      expect(vi.getTimerCount()).toBe(0);

      h.service.settlePush({
        type: "push_complete",
        branchName: "feature/test",
        repoOwner: "acme",
        repoName: "web",
        timestamp: 1000,
      });
      expect(h.log.warn).toHaveBeenCalledWith(
        "Push event matched no pending resolver",
        expect.objectContaining({ pending_resolvers: [] })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  describe("resolver keying", () => {
    it.each(["push_complete", "push_error"] as const)(
      "ignores stale %s command IDs instead of falling back to repo identity or the sole resolver",
      async (type) => {
        vi.useFakeTimers();
        try {
          const h = createService();
          const pushSpec = createPushSpec("acme", "web", "feature/test");
          const first = h.service.pushBranchToRemote(pushSpec);
          const firstCommandId = h.commands.sendPush.mock.calls[0][2];
          await vi.runOnlyPendingTimersAsync();
          await expect(first).resolves.toEqual({
            success: false,
            error: expect.stringContaining("Push operation timed out"),
          });

          const retryResult = vi.fn();
          const retry = h.service.pushBranchToRemote(pushSpec).then(retryResult);
          const retryCommandId = h.commands.sendPush.mock.calls[1][2];
          expect(retryCommandId).not.toBe(firstCommandId);
          const staleEvent = {
            ...(type === "push_error" ? { type, error: "stale failure" } : { type }),
            commandId: firstCommandId,
            timestamp: 1000,
          };
          h.service.settlePush({
            ...staleEvent,
            branchName: pushSpec.targetBranch,
            repoOwner: pushSpec.repoOwner,
            repoName: pushSpec.repoName,
          });
          h.service.settlePush(staleEvent);
          await vi.advanceTimersByTimeAsync(0);

          expect(retryResult).not.toHaveBeenCalled();
          expect(h.log.warn).toHaveBeenCalledTimes(2);
          expect(h.commands.discard).not.toHaveBeenCalledWith(retryCommandId);
          expect(vi.getTimerCount()).toBe(1);

          h.service.settlePush({
            type: "push_complete",
            commandId: retryCommandId,
            timestamp: 1001,
          });
          await retry;
          expect(retryResult).toHaveBeenCalledWith({ success: true });
          expect(h.commands.discard).toHaveBeenCalledWith(retryCommandId);
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          vi.clearAllTimers();
          vi.useRealTimers();
        }
      }
    );

    it.each(["false", "reject"] as const)(
      "preserves a same-key retry when the timed-out sendPush later returns %s",
      async (outcome) => {
        vi.useFakeTimers();
        try {
          const h = createService();
          const pushSpec = createPushSpec("acme", "web", "feature/test");
          let resolveSend!: (delivered: boolean) => void;
          let rejectSend!: (error: Error) => void;
          h.commands.sendPush.mockImplementationOnce(
            () =>
              new Promise<boolean>((resolve, reject) => {
                resolveSend = resolve;
                rejectSend = reject;
              })
          );

          const first = h.service.pushBranchToRemote(pushSpec);
          const firstCommandId = h.commands.sendPush.mock.calls[0][2];
          await vi.runOnlyPendingTimersAsync();
          await expect(first).resolves.toEqual({
            success: false,
            error: expect.stringContaining("Push operation timed out"),
          });
          expect(h.commands.discard).toHaveBeenCalledWith(firstCommandId);

          const retryResult = vi.fn();
          const retry = h.service.pushBranchToRemote(pushSpec).then(retryResult);
          const retryCommandId = h.commands.sendPush.mock.calls[1][2];
          expect(retryCommandId).not.toBe(firstCommandId);
          await vi.advanceTimersByTimeAsync(0);
          if (outcome === "false") {
            resolveSend(false);
          } else {
            rejectSend(new Error("late persistence failure"));
          }
          await vi.advanceTimersByTimeAsync(0);

          expect(retryResult).not.toHaveBeenCalled();
          expect(h.commands.discard).not.toHaveBeenCalledWith(retryCommandId);
          expect(vi.getTimerCount()).toBe(1);
          await expect(h.service.pushBranchToRemote(pushSpec)).resolves.toEqual({
            success: false,
            error: expect.stringContaining("Push already in flight"),
          });
          expect(h.commands.sendPush).toHaveBeenCalledTimes(2);

          h.service.settlePush({
            type: "push_complete",
            commandId: retryCommandId,
            timestamp: 1001,
          });
          await retry;
          expect(retryResult).toHaveBeenCalledWith({ success: true });
          expect(h.commands.discard).toHaveBeenCalledWith(retryCommandId);
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          vi.clearAllTimers();
          vi.useRealTimers();
        }
      }
    );

    it("does not remove a same-key replacement during the previous push's cleanup", async () => {
      vi.useFakeTimers();
      try {
        const h = createService();
        const pushSpec = createPushSpec("acme", "web", "feature/test");
        const first = h.service.pushBranchToRemote(pushSpec);
        const firstCommandId = h.commands.sendPush.mock.calls[0][2];
        h.service.settlePush({ type: "push_complete", commandId: firstCommandId, timestamp: 1000 });

        // Start the replacement before the first push's finally block runs.
        const retry = h.service.pushBranchToRemote(pushSpec);
        const retryCommandId = h.commands.sendPush.mock.calls[1][2];
        await expect(first).resolves.toEqual({ success: true });
        expect(h.commands.discard).toHaveBeenCalledWith(firstCommandId);
        expect(h.commands.discard).not.toHaveBeenCalledWith(retryCommandId);
        await expect(h.service.pushBranchToRemote(pushSpec)).resolves.toEqual({
          success: false,
          error: expect.stringContaining("Push already in flight"),
        });
        expect(h.commands.sendPush).toHaveBeenCalledTimes(2);

        h.service.settlePush({ type: "push_complete", commandId: retryCommandId, timestamp: 1001 });
        await expect(retry).resolves.toEqual({ success: true });
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    });

    it("rejects a same-key concurrent push after the sandbox disconnects", async () => {
      const h = createService();
      const pushSpec = createPushSpec("acme", "web", "feature/test");
      const firstResult = vi.fn();
      const first = h.service.pushBranchToRemote(pushSpec).then(firstResult);

      try {
        h.wsManager.getSandboxCommandTarget.mockReturnValue({ kind: "unavailable" });

        await expect(h.service.pushBranchToRemote(pushSpec)).resolves.toEqual({
          success: false,
          error: expect.stringContaining("Push already in flight"),
        });
        expect(h.wsManager.send).toHaveBeenCalledTimes(1);
        expect(firstResult).not.toHaveBeenCalled();
      } finally {
        h.service.settlePush({
          type: "push_complete",
          branchName: pushSpec.targetBranch,
          repoOwner: pushSpec.repoOwner,
          repoName: pushSpec.repoName,
          timestamp: 1000,
        });
        await first;
      }

      expect(firstResult).toHaveBeenCalledWith({ success: true });
    });

    it.each(["push_complete", "push_error", "timeout"] as const)(
      "rejects a same-key concurrent push and preserves the first caller through %s",
      async (outcome) => {
        vi.useFakeTimers();
        try {
          const h = createService();
          const pushSpec = createPushSpec("acme", "web", "feature/test");
          const firstResult = vi.fn();
          const secondResult = vi.fn();
          const first = h.service.pushBranchToRemote(pushSpec).then(firstResult);
          const second = h.service.pushBranchToRemote(pushSpec).then(secondResult);
          await vi.advanceTimersByTimeAsync(0);

          expect(secondResult).toHaveBeenCalledWith({
            success: false,
            error: expect.stringContaining("Push already in flight"),
          });
          expect(firstResult).not.toHaveBeenCalled();
          expect(h.wsManager.send).toHaveBeenCalledTimes(1);
          expect(vi.getTimerCount()).toBe(1);

          if (outcome === "timeout") {
            await vi.runAllTimersAsync();
          } else {
            h.service.settlePush({
              ...(outcome === "push_error"
                ? { type: outcome, error: "remote rejected" }
                : { type: outcome }),
              branchName: pushSpec.targetBranch,
              repoOwner: pushSpec.repoOwner,
              repoName: pushSpec.repoName,
              timestamp: 1000,
            });
          }
          await Promise.all([first, second]);

          expect(firstResult).toHaveBeenCalledWith(
            outcome === "push_complete"
              ? { success: true }
              : {
                  success: false,
                  error: expect.stringContaining(
                    outcome === "timeout" ? "Push operation timed out" : "remote rejected"
                  ),
                }
          );
          expect(vi.getTimerCount()).toBe(0);

          // Completion, failure, and timeout must all release the key for retry.
          const retry = h.service.pushBranchToRemote(pushSpec);
          expect(h.wsManager.send).toHaveBeenCalledTimes(2);
          h.service.settlePush({
            type: "push_complete",
            branchName: pushSpec.targetBranch,
            repoOwner: pushSpec.repoOwner,
            repoName: pushSpec.repoName,
            timestamp: 1001,
          });
          await expect(retry).resolves.toEqual({ success: true });
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          vi.clearAllTimers();
          vi.useRealTimers();
        }
      }
    );

    it("settles the matching push when two repos push the same branch name", async () => {
      const h = createService();
      const webPush = h.service.pushBranchToRemote(
        createPushSpec("acme", "web", "open-inspect/session-1")
      );
      const backendPush = h.service.pushBranchToRemote(
        createPushSpec("acme", "backend", "open-inspect/session-1")
      );

      h.service.settlePush({
        type: "push_error",
        branchName: "open-inspect/session-1",
        repoOwner: "acme",
        repoName: "backend",
        error: "remote rejected",
        timestamp: 1000,
      });
      h.service.settlePush({
        type: "push_complete",
        branchName: "open-inspect/session-1",
        repoOwner: "acme",
        repoName: "web",
        timestamp: 1001,
      });

      await expect(webPush).resolves.toEqual({ success: true });
      await expect(backendPush).resolves.toEqual({
        success: false,
        error: expect.stringContaining("remote rejected"),
      });
    });

    it("settles the sole pending push on a terminal event without repo identity", async () => {
      const h = createService();
      const pushPromise = h.service.pushBranchToRemote(
        createPushSpec("acme", "web", "feature/test")
      );

      // Legacy single-repo runtimes echo no repo identity.
      h.service.settlePush({
        type: "push_complete",
        branchName: "feature/test",
        timestamp: 1000,
      });

      await expect(pushPromise).resolves.toEqual({ success: true });
    });

    it("rejects the sole pending push on a branch-less push_error", async () => {
      const h = createService();
      const pushPromise = h.service.pushBranchToRemote(
        createPushSpec("acme", "web", "feature/test")
      );

      // The bridge's "no repository found" path emits push_error with no
      // branchName at all; it must reject the pending push instead of
      // leaking it until PUSH_TIMEOUT_MS expires.
      h.service.settlePush({
        type: "push_error",
        error: "No repository found for push",
        timestamp: 1000,
      });

      await expect(pushPromise).resolves.toEqual({
        success: false,
        error: expect.stringContaining("No repository found for push"),
      });
    });

    it("drops a fully identified event that mismatches the sole pending push", async () => {
      const h = createService();
      const pushPromise = h.service.pushBranchToRemote(
        createPushSpec("acme", "web", "feature/test")
      );

      // A stale event for a different repo must not settle the pending push
      // just because it is the only one in flight.
      h.service.settlePush({
        type: "push_error",
        branchName: "feature/test",
        repoOwner: "acme",
        repoName: "backend",
        error: "remote rejected",
        timestamp: 1000,
      });
      h.service.settlePush({
        type: "push_complete",
        branchName: "feature/test",
        repoOwner: "acme",
        repoName: "web",
        timestamp: 1001,
      });

      await expect(pushPromise).resolves.toEqual({ success: true });
    });

    it("drops an identity-less terminal event when several pushes are pending", async () => {
      const h = createService();
      const webPush = h.service.pushBranchToRemote(createPushSpec("acme", "web", "feature/a"));
      const backendPush = h.service.pushBranchToRemote(
        createPushSpec("acme", "backend", "feature/b")
      );

      h.service.settlePush({
        type: "push_error",
        error: "ambiguous",
        timestamp: 1000,
      });

      // Neither push settles from the ambiguous event; identified events do.
      h.service.settlePush({
        type: "push_complete",
        branchName: "feature/a",
        repoOwner: "acme",
        repoName: "web",
        timestamp: 1001,
      });
      h.service.settlePush({
        type: "push_complete",
        branchName: "feature/b",
        repoOwner: "acme",
        repoName: "backend",
        timestamp: 1002,
      });

      await expect(webPush).resolves.toEqual({ success: true });
      await expect(backendPush).resolves.toEqual({ success: true });
    });
  });
});
