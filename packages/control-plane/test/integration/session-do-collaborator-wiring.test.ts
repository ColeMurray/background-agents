import { beforeEach, describe, expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { Mock } from "vitest";
import type { SandboxLifecycleManager } from "../../src/sandbox/lifecycle/manager";
import type { PresenceService } from "../../src/session/presence-service";
import type { SessionSandboxEventProcessor } from "../../src/session/sandbox-events";
import type { SessionDO } from "../../src/session/durable-object";
import type { SourceControlProvider } from "../../src/source-control";
import type { GitPushSpec } from "../../src/source-control";
import { cleanD1Tables } from "./cleanup";
import { initSession, queryDO, seedMessage, waitForSandboxStatus } from "./helpers";

/**
 * The SessionDO hands its collaborators to each other through thunks. Several
 * of those edges are invisible to the rest of the suite: nothing else drives
 * the warm-on-typing spawn, nothing else reads a sandbox row that actually has
 * `tunnel_urls` set, and the snapshot and branch-push edges both have
 * success-shaped fallbacks that hide a missing call. Repointing any of those
 * thunks at the wrong collaborator — or dropping it entirely — would stay green
 * everywhere else, so these tests pin them.
 */

/** The getters are private to the DO; tests read them to assert how it wires. */
function lifecycleManagerOf(instance: SessionDO): SandboxLifecycleManager {
  return (instance as unknown as { lifecycleManager: SandboxLifecycleManager }).lifecycleManager;
}

function presenceServiceOf(instance: SessionDO): PresenceService {
  return (instance as unknown as { presenceService: PresenceService }).presenceService;
}

function sandboxEventProcessorOf(instance: SessionDO): SessionSandboxEventProcessor {
  return (instance as unknown as { sandboxEventProcessor: SessionSandboxEventProcessor })
    .sandboxEventProcessor;
}

/** Enough of a provider for PR creation to reach the branch-push step. */
function stubSourceControlProvider(): SourceControlProvider {
  return {
    name: "github",
    generatePushAuth: async () => ({ authType: "app", token: "push-token" as const }),
    getRepository: async () => ({
      owner: "acme",
      name: "web-app",
      fullName: "acme/web-app",
      defaultBranch: "main",
      isPrivate: true,
      providerRepoId: 12345,
    }),
    createPullRequest: async () => ({
      id: 99,
      webUrl: "https://github.com/acme/web-app/pull/99",
      apiUrl: "https://api.github.com/repos/acme/web-app/pulls/99",
      lifecycleState: "open" as const,
      isDraft: false,
      sourceBranch: "open-inspect/test-session",
      targetBranch: "main",
    }),
    buildManualPullRequestUrl: (config: {
      owner: string;
      name: string;
      sourceBranch: string;
      targetBranch: string;
    }) =>
      `https://github.com/${config.owner}/${config.name}/pull/new/${config.targetBranch}...${config.sourceBranch}`,
    buildGitPushSpec: (config: { targetBranch: string }) => ({
      remoteUrl: "https://example.invalid/repo.git",
      redactedRemoteUrl: "https://example.invalid/<redacted>.git",
      refspec: `HEAD:refs/heads/${config.targetBranch}`,
      targetBranch: config.targetBranch,
      force: true,
    }),
  } as unknown as SourceControlProvider;
}

describe("SessionDO collaborator wiring", () => {
  beforeEach(async () => {
    await cleanD1Tables();
  });

  it("routes a typing notification to the lifecycle manager's spawn", async () => {
    const { stub } = await initSession({ userId: "user-1" });
    // Init kicks off a background warm spawn that fails (Modal is unavailable in
    // integration tests). Wait for it to settle so isSpawning() is false and
    // typing takes the spawn branch rather than short-circuiting.
    await waitForSandboxStatus(stub, "failed");

    const spawned = await runInDurableObject(stub, async (instance: SessionDO) => {
      const manager = lifecycleManagerOf(instance);
      const spawnSandbox = vi.fn(async () => {});
      manager.spawnSandbox = spawnSandbox;

      await presenceServiceOf(instance).handleTyping();

      return spawnSandbox.mock.calls.length;
    });

    expect(spawned).toBe(1);
  });

  it("routes execution_complete to the lifecycle manager's snapshot trigger", async () => {
    const { stub } = await initSession({ userId: "user-1" });
    await waitForSandboxStatus(stub, "failed");

    await runInDurableObject(stub, (instance: SessionDO) => {
      lifecycleManagerOf(instance).triggerSnapshot = vi.fn(async (_reason: string) => {});
    });

    const response = await stub.fetch("http://internal/internal/sandbox-event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "execution_complete",
        messageId: "msg-snapshot-wiring",
        success: true,
        sandboxId: "sb-1",
        timestamp: Date.now() / 1000,
      }),
    });
    expect(response.status).toBe(200);

    const reasons = await runInDurableObject(stub, (instance: SessionDO) => {
      const spy = lifecycleManagerOf(instance).triggerSnapshot as unknown as Mock<
        (reason: string) => Promise<void>
      >;
      return spy.mock.calls.map((call) => call[0]);
    });

    expect(reasons).toEqual(["execution_complete"]);
  });

  it("routes a pull request's branch push through the sandbox event processor", async () => {
    const { stub } = await initSession({ userId: "user-1" });
    const participants = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants WHERE user_id = ?",
      "user-1"
    );
    const ownerParticipantId = participants[0]?.id;
    if (!ownerParticipantId) throw new Error("Expected owner participant");

    await seedMessage(stub, {
      id: "msg-push-wiring",
      authorId: ownerParticipantId,
      content: "Create a PR",
      source: "web",
      status: "processing",
      createdAt: Date.now() - 1000,
      startedAt: Date.now() - 500,
    });

    await runInDurableObject(stub, (instance: SessionDO) => {
      (
        instance as unknown as { _sourceControlProvider: SourceControlProvider | null }
      )._sourceControlProvider = stubSourceControlProvider();
      // Without a connected sandbox the real implementation short-circuits to
      // `{ success: true }`, which is exactly what a dropped edge would return.
      // Spying is the only way to tell the two apart from out here.
      sandboxEventProcessorOf(instance).pushBranchToRemote = vi.fn(
        async (_pushSpec: GitPushSpec) => ({ success: true as const })
      );
    });

    const response = await stub.fetch("http://internal/internal/create-pr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Test PR", body: "Body from integration test" }),
    });
    expect(response.status).toBe(200);

    const remoteUrls = await runInDurableObject(stub, (instance: SessionDO) => {
      const spy = sandboxEventProcessorOf(instance).pushBranchToRemote as unknown as Mock<
        (pushSpec: GitPushSpec) => Promise<{ success: true }>
      >;
      return spy.mock.calls.map((call) => call[0].remoteUrl);
    });

    expect(remoteUrls).toEqual(["https://example.invalid/repo.git"]);
  });

  it("keeps session init succeeding when the sandbox provider cannot be built", async () => {
    const sessionName = `wiring-provider-throws-${crypto.randomUUID()}`;
    const stub = env.SESSION.get(env.SESSION.idFromName(sessionName));

    // `lifecycleManager` is a lazy getter that constructs the sandbox provider,
    // and that construction throws on a deployment missing provider
    // credentials. Shadow it before init so the warm-spawn thunk hits the same
    // failure; init must still succeed, because its session rows are already
    // committed by the time the warm spawn is scheduled.
    await runInDurableObject(stub, (instance: SessionDO) => {
      Object.defineProperty(instance, "lifecycleManager", {
        configurable: true,
        get() {
          throw new Error("MODAL_API_SECRET and MODAL_WORKSPACE are required");
        },
      });
    });

    try {
      const response = await stub.fetch("http://internal/internal/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionName,
          repoOwner: "acme",
          repoName: "web-app",
          repoId: 12345,
          userId: "user-1",
        }),
      });

      expect(response.status).toBe(200);
    } finally {
      await runInDurableObject(stub, (instance: SessionDO) => {
        delete (instance as unknown as Record<string, unknown>).lifecycleManager;
      });
    }
  });

  it("surfaces stored tunnel URLs in the session snapshot", async () => {
    const { stub } = await initSession({ userId: "user-1" });
    // The snapshot reads `tunnel_urls` regardless of sandbox status, so leave
    // the row in the terminal `failed` state the test spawn put it in. Reviving
    // it to `ready` would re-arm the lifecycle alarm against the row, and that
    // alarm clears `tunnel_urls`.
    await waitForSandboxStatus(stub, "failed");
    await queryDO(
      stub,
      "UPDATE sandbox SET tunnel_urls = ?",
      JSON.stringify({ "3000": "https://app.tunnel.test", "5000": "https://api.tunnel.test" })
    );

    const response = await stub.fetch("http://internal/internal/snapshot");
    expect(response.status).toBe(200);

    const snapshot = await response.json<{ session: { tunnelUrls: unknown } }>();
    expect(snapshot.session.tunnelUrls).toEqual({
      "3000": "https://app.tunnel.test",
      "5000": "https://api.tunnel.test",
    });
  });

  it("falls open to no tunnel URLs when the stored blob is corrupt", async () => {
    const { stub } = await initSession({ userId: "user-1" });
    await waitForSandboxStatus(stub, "failed");
    await queryDO(stub, "UPDATE sandbox SET tunnel_urls = ?", "{not json");

    const response = await stub.fetch("http://internal/internal/snapshot");
    expect(response.status).toBe(200);

    const snapshot = await response.json<{ session: { tunnelUrls: unknown } }>();
    expect(snapshot.session.tunnelUrls).toBeNull();

    // Pin that null came from the parser falling open rather than from the blob
    // having been cleared out from under the read.
    const rows = await queryDO<{ tunnel_urls: string | null }>(
      stub,
      "SELECT tunnel_urls FROM sandbox"
    );
    expect(rows[0]?.tunnel_urls).toBe("{not json");
  });
});
