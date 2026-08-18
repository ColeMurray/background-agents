/**
 * Regression test: the generic `execution_complete` snapshot path must not
 * reboot a live E2B session.
 *
 * `sandbox-events.ts` calls `triggerSnapshot("execution_complete")` after every
 * execution. The generic provider operation must create a resumable snapshot
 * directly; the destructive pause(memory:false) → connect sequence is reserved
 * for image-build baking.
 */

import { describe, it, expect, vi } from "vitest";
import { SandboxLifecycleManager, DEFAULT_LIFECYCLE_CONFIG } from "./manager";
import { E2BSandboxProvider } from "../providers/e2b-provider";
import type { E2BRestClient } from "../e2b-rest-client";

function spyE2BClient() {
  return {
    config: { apiUrl: "https://api.e2b.app", apiKey: "k", templateId: "tmpl" },
    pauseSandbox: vi.fn(async () => {}),
    connectSandbox: vi.fn(async () => ({
      sandboxID: "e2b-live-id",
      templateID: "tmpl",
      state: "running",
    })),
    createSnapshot: vi.fn(async () => ({ snapshotID: "snap-live:default", names: [] })),
    killSandbox: vi.fn(async () => {}),
    getHostnameForPort: vi.fn((id: string, port: number) => `https://${port}-${id}.e2b.app`),
  } as unknown as E2BRestClient;
}

function stubbedManager(client: E2BRestClient) {
  const provider = new E2BSandboxProvider(client, {
    scmProvider: "github",
    codeServerPasswordSecret: "secret",
    sandboxTimeoutSeconds: 1800,
    autoPause: true,
  });

  // Live session sandbox — actively serving a user (status "ready", real provider id).
  const sandbox = { id: "sandbox-1", modal_object_id: "e2b-live-id", status: "ready" };
  const storage = {
    getSandbox: vi.fn(() => sandbox),
    getSession: vi.fn(() => ({ id: "session-1", session_name: "session-1" })),
    updateSandboxStatus: vi.fn((s: string) => {
      sandbox.status = s;
    }),
    updateSandboxSnapshotImageId: vi.fn(),
  };
  const broadcaster = { broadcast: vi.fn() };

  const manager = new SandboxLifecycleManager(
    provider,
    storage as never,
    broadcaster as never,
    { getSandboxWebSocket: () => null } as never,
    { scheduleAlarm: vi.fn(async () => {}) } as never,
    { generateId: () => "id-1" } as never,
    {
      ...DEFAULT_LIFECYCLE_CONFIG,
      controlPlaneUrl: "https://cp.test",
      model: "anthropic/claude",
    } as never
  );
  return { manager, storage };
}

describe("execution_complete snapshot on a live E2B session", () => {
  it("snapshots without pause(memory:false) or reconnecting", async () => {
    const client = spyE2BClient();
    const { manager } = stubbedManager(client);

    // This is exactly what sandbox-events.ts fires after every prompt.
    await manager.triggerSnapshot("execution_complete");

    expect(client.pauseSandbox).not.toHaveBeenCalled();
    expect(client.connectSandbox).not.toHaveBeenCalled();
    expect(client.createSnapshot).toHaveBeenCalledWith("e2b-live-id");
  });
});
