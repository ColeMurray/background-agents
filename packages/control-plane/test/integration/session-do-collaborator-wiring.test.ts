import { beforeEach, describe, expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { Mock } from "vitest";
import type { SessionComponents } from "../../src/session/components";
import type { SessionDO } from "../../src/session/durable-object";
import type { SourceControlProvider } from "../../src/source-control";
import type { GitPushSpec } from "../../src/source-control";
import { cleanD1Tables } from "./cleanup";
import { componentsOf } from "./session-do-access";
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

/**
 * SEAM — the single place this suite reaches past `SessionDO`'s encapsulation.
 *
 * The edges below have success-shaped fallbacks: without a connected sandbox
 * the real `pushBranchToRemote` returns `{ success: true }`, and a dropped
 * snapshot trigger is silent. Spying is the only way to tell "wired correctly"
 * from "dropped entirely" from outside the DO.
 *
 * This does pin the DO's current private composition topology, which is a real
 * cost. It is deliberately confined to this one function so the cost is one
 * edit, not one per test: when the composition-root refactor replaces these
 * lazy getters with an explicit `SessionComponents` seam, repoint THIS function
 * at it and every test below should keep passing unchanged.
 */
function collaboratorsOf(
  instance: SessionDO
): Pick<SessionComponents, "lifecycleManager" | "presenceService" | "sandboxEventProcessor"> {
  return componentsOf(instance);
}

/** The repository this suite's stubbed provider pushes to. */
const PUSH_REPO = { repoOwner: "acme", repoName: "web-app" } as const;

function notUsedHere(member: string): never {
  throw new Error(`${member} is not exercised by the collaborator-wiring suite`);
}

/**
 * Enough of a provider for PR creation to reach the branch-push step.
 *
 * Typed as a full `SourceControlProvider` rather than cast through `unknown`:
 * `buildGitPushSpec` must return a complete `GitPushSpec`, and `repoOwner` /
 * `repoName` are the fields that select the checkout in multi-repo sandboxes.
 * A double cast would let this stub silently drop them.
 */
function stubSourceControlProvider(): SourceControlProvider {
  return {
    name: "github",
    generatePushAuth: async () => ({ authType: "app", token: "push-token" as const }),
    getRepository: async () => ({
      owner: PUSH_REPO.repoOwner,
      name: PUSH_REPO.repoName,
      fullName: `${PUSH_REPO.repoOwner}/${PUSH_REPO.repoName}`,
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
    buildManualPullRequestUrl: (config) =>
      `https://github.com/${config.owner}/${config.name}/pull/new/${config.targetBranch}...${config.sourceBranch}`,
    buildGitPushSpec: (config) => ({
      remoteUrl: "https://example.invalid/repo.git",
      redactedRemoteUrl: "https://example.invalid/<redacted>.git",
      refspec: `${config.sourceRef}:refs/heads/${config.targetBranch}`,
      targetBranch: config.targetBranch,
      repoOwner: config.owner,
      repoName: config.name,
      // Both real providers derive this the same way; mirroring them keeps the
      // stub honest about the contract rather than pinning a literal.
      force: config.force ?? false,
    }),
    checkRepositoryAccess: () => notUsedHere("checkRepositoryAccess"),
    listRepositories: () => notUsedHere("listRepositories"),
    listBranches: () => notUsedHere("listBranches"),
    getBranchHead: () => notUsedHere("getBranchHead"),
    getPullRequest: () => notUsedHere("getPullRequest"),
    generateCredentialHelperAuth: () => notUsedHere("generateCredentialHelperAuth"),
  };
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
      const collaborators = collaboratorsOf(instance);
      const spawnSandbox = vi.fn(async () => {});
      collaborators.lifecycleManager.spawnSandbox = spawnSandbox;

      await collaborators.presenceService.handleTyping();

      return spawnSandbox.mock.calls.length;
    });

    expect(spawned).toBe(1);
  });

  it("routes execution_complete to the lifecycle manager's snapshot trigger", async () => {
    const { stub } = await initSession({ userId: "user-1" });
    await waitForSandboxStatus(stub, "failed");

    await runInDurableObject(stub, (instance: SessionDO) => {
      collaboratorsOf(instance).lifecycleManager.triggerSnapshot = vi.fn(
        async (_reason: string) => {}
      );
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
      const spy = collaboratorsOf(instance).lifecycleManager.triggerSnapshot as unknown as Mock<
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
      // SCM access reads through the components record, so replacing this
      // property substitutes the stub for every consumer.
      const provider = stubSourceControlProvider();
      componentsOf(instance).sourceControlProvider = provider;
      // Without a connected sandbox the real implementation short-circuits to
      // `{ success: true }`, which is exactly what a dropped edge would return.
      // Spying is the only way to tell the two apart from out here.
      collaboratorsOf(instance).sandboxEventProcessor.pushBranchToRemote = vi.fn(
        async (_pushSpec: GitPushSpec) => ({ success: true as const })
      );
    });

    const response = await stub.fetch("http://internal/internal/create-pr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Test PR", body: "Body from integration test" }),
    });
    expect(response.status).toBe(200);

    const pushSpecs = await runInDurableObject(stub, (instance: SessionDO) => {
      const spy = collaboratorsOf(instance).sandboxEventProcessor
        .pushBranchToRemote as unknown as Mock<
        (pushSpec: GitPushSpec) => Promise<{ success: true }>
      >;
      return spy.mock.calls.map((call) => ({
        remoteUrl: call[0].remoteUrl,
        repoOwner: call[0].repoOwner,
        repoName: call[0].repoName,
      }));
    });

    // Repository identity travels with the push spec — it selects the checkout
    // in multi-repo sandboxes, so a spec that carried only the remote URL would
    // push against the wrong working tree.
    expect(pushSpecs).toEqual([
      {
        remoteUrl: "https://example.invalid/repo.git",
        repoOwner: PUSH_REPO.repoOwner,
        repoName: PUSH_REPO.repoName,
      },
    ]);
  });

  it("keeps session init succeeding when the warm spawn fails at runtime", async () => {
    const sessionName = `wiring-provider-throws-${crypto.randomUUID()}`;
    const stub = env.SESSION.get(env.SESSION.idFromName(sessionName));

    // A runtime spawn failure (provider API down, quota exhausted) rejects
    // `warmSandbox`; init must still succeed, because its session rows are
    // already committed by the time the warm spawn runs. (Init's own
    // ensureInitialized() is idempotent, so pre-initializing here matches
    // production order within the same activation.)
    await runInDurableObject(stub, (instance: SessionDO) => {
      componentsOf(instance).lifecycleManager.warmSandbox = vi.fn(() =>
        Promise.reject(new Error("modal API unavailable"))
      );
    });

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

    // Asserting only the 200 would be a false positive: removing warm-spawn
    // scheduling from init altogether also returns 200. The call count is
    // what pins that init still reaches the warm-spawn edge, so the 200 is
    // evidence the rejection was absorbed rather than evidence it never
    // happened. `submit` runs the task factory synchronously and routes the
    // rejection to background_task.failed instead of letting it escape.
    const warmSpawnCalls = await runInDurableObject(stub, (instance: SessionDO) => {
      const spy = componentsOf(instance).lifecycleManager.warmSandbox as unknown as Mock<
        () => Promise<void>
      >;
      return spy.mock.calls.length;
    });
    expect(warmSpawnCalls).toBeGreaterThan(0);
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
