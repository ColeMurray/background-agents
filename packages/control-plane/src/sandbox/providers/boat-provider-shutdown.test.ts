import { describe, expect, it, vi } from "vitest";
import { BoatNotFoundError, type BoatRestClient, type BoatSandbox } from "../boat-rest-client";
import { BoatSandboxProvider } from "./boat-provider";

const ready: BoatSandbox = {
  id: "bx_23456789",
  name: "Sandbox",
  state: "ready",
  archiveAfter: "2030-01-01T02:00:00Z",
  snapshotAvailable: false,
};

function provider(overrides: Partial<BoatRestClient>) {
  const client = {
    getSandbox: vi.fn(async () => ready),
    stopSandbox: vi.fn(async () => {}),
    deleteSandbox: vi.fn(async () => ({
      id: "bdop_0123456789abcdef0123456789abcdef",
      kind: "sandbox" as const,
      targetId: ready.id,
      status: "pending" as const,
      attemptCount: 0,
      requestedAt: "2030-01-01T00:00:00Z",
      completedAt: null,
    })),
    getDeletionOperation: vi.fn(async () => ({
      id: "bdop_0123456789abcdef0123456789abcdef",
      kind: "sandbox" as const,
      targetId: ready.id,
      status: "blocked" as const,
      attemptCount: 1,
      requestedAt: "2030-01-01T00:00:00Z",
      completedAt: null,
    })),
    ...overrides,
  } as unknown as BoatRestClient;
  return {
    client,
    provider: new BoatSandboxProvider(client, {
      scmProvider: "github",
      sandboxAccessPasswordSecret: "stable",
      defaultType: "default",
      deploymentName: "test-deployment",
    }),
  };
}

describe("BoatSandboxProvider shutdown", () => {
  it("preserves with non-forced stop and verifies the observed stopped state", async () => {
    const { client, provider: boat } = provider({
      getSandbox: vi
        .fn()
        .mockResolvedValueOnce(ready)
        .mockResolvedValueOnce({ ...ready, state: "stopped", snapshotAvailable: true }),
    });
    await expect(
      boat.stopSandbox({
        providerObjectId: ready.id,
        sessionId: "session-1",
        reason: "inactivity_timeout",
        intent: "preserve",
      })
    ).resolves.toEqual({ success: true });
    expect(client.stopSandbox).toHaveBeenCalledWith(ready.id, undefined);
    expect(client.deleteSandbox).not.toHaveBeenCalled();
  });

  it("refuses to report preservation without a verified snapshot", async () => {
    const { provider: boat } = provider({
      getSandbox: vi
        .fn()
        .mockResolvedValueOnce(ready)
        .mockResolvedValueOnce({ ...ready, state: "stopped", snapshotAvailable: false }),
    });
    await expect(
      boat.stopSandbox({
        providerObjectId: ready.id,
        sessionId: "session-1",
        reason: "inactivity_timeout",
        intent: "preserve",
      })
    ).resolves.toMatchObject({ success: false, error: expect.stringContaining("verified") });
  });

  it("treats an accepted deletion plus 404 as logical destruction even when cleanup is blocked", async () => {
    const { client, provider: boat } = provider({
      getSandbox: vi.fn(async () => {
        throw new BoatNotFoundError("gone");
      }),
    });
    await expect(
      boat.stopSandbox({
        providerObjectId: ready.id,
        sessionId: "session-1",
        reason: "respawn",
        intent: "destroy",
      })
    ).resolves.toEqual({ success: true });
    expect(client.deleteSandbox).toHaveBeenCalled();
  });

  it("does not treat a missing sandbox as successful preservation", async () => {
    const { provider: boat } = provider({
      getSandbox: vi.fn(async () => {
        throw new BoatNotFoundError("gone");
      }),
    });
    await expect(
      boat.stopSandbox({
        providerObjectId: ready.id,
        sessionId: "session-1",
        reason: "inactivity_timeout",
        intent: "preserve",
      })
    ).resolves.toMatchObject({ success: false });
  });

  it("passes the caller deadline signal through stop and verification", async () => {
    const getSandbox = vi
      .fn()
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce({ ...ready, state: "stopped", snapshotAvailable: true });
    const { client, provider: boat } = provider({ getSandbox });
    await boat.stopSandbox({
      providerObjectId: ready.id,
      sessionId: "session-1",
      reason: "sandbox_lifetime_expiring",
      intent: "preserve",
      deadlineAtMs: Date.now() + 10_000,
    });
    expect(vi.mocked(client.stopSandbox).mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
    expect(getSandbox.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
  });
});
