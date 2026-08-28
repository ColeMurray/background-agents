import { describe, expect, it, vi } from "vitest";
import type { GitPushSpec } from "../source-control";
import { SandboxPushService } from "./sandbox-push-service";
import type { SessionWebSocketManager } from "./websocket-manager";

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

function createService() {
  const sandboxWs = { readyState: WebSocket.OPEN } as WebSocket;
  const wsManager = {
    getSandboxSocket: vi.fn(() => sandboxWs),
    send: vi.fn(() => true),
  };
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  const service = new SandboxPushService(log, wsManager as unknown as SessionWebSocketManager);
  return { service, wsManager, log };
}

describe("SandboxPushService", () => {
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
