import { beforeEach, describe, expect, it, vi } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import type { SandboxLifecycleManager } from "../../src/sandbox/lifecycle/manager";
import type { PresenceService } from "../../src/session/presence-service";
import type { SessionDO } from "../../src/session/durable-object";
import { cleanD1Tables } from "./cleanup";
import { initSession, queryDO, waitForSandboxStatus } from "./helpers";

/**
 * The SessionDO hands its collaborators to each other through thunks. Two of
 * those edges are invisible to the rest of the suite: nothing else drives the
 * warm-on-typing spawn, and nothing else reads a sandbox row that actually has
 * `tunnel_urls` set. Repointing either thunk at the wrong collaborator would
 * stay green everywhere else, so these tests pin them.
 */

/** The getters are private to the DO; tests read them to assert how it wires. */
function lifecycleManagerOf(instance: SessionDO): SandboxLifecycleManager {
  return (instance as unknown as { lifecycleManager: SandboxLifecycleManager }).lifecycleManager;
}

function presenceServiceOf(instance: SessionDO): PresenceService {
  return (instance as unknown as { presenceService: PresenceService }).presenceService;
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

  it("surfaces stored tunnel URLs in the session snapshot", async () => {
    const { stub } = await initSession({ userId: "user-1" });
    await waitForSandboxStatus(stub, "failed");
    await queryDO(
      stub,
      "UPDATE sandbox SET status = 'ready', tunnel_urls = ?",
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
    await queryDO(stub, "UPDATE sandbox SET status = 'ready', tunnel_urls = ?", "{not json");

    const response = await stub.fetch("http://internal/internal/snapshot");
    expect(response.status).toBe(200);

    const snapshot = await response.json<{ session: { tunnelUrls: unknown } }>();
    expect(snapshot.session.tunnelUrls).toBeNull();
  });
});
