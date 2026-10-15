import { afterEach, expect, it, vi } from "vitest";
import { cleanupOpenComputerCanary } from "../../test/helpers/opencomputer-canary";
import type { OpenComputerRestClient } from "./opencomputer-rest-client";
import { OpenComputerSandboxProvider } from "./providers/opencomputer-provider";

afterEach(() => vi.useRealTimers());

it("discovers and deletes a capture lost after creation and a readiness-poll error", async () => {
  vi.useFakeTimers();
  const pending = { id: "cp-unknown", sandboxId: "sb-canary", status: "processing" };
  const client = {
    createCheckpoint: vi.fn().mockResolvedValue(pending),
    listCheckpoints: vi
      .fn()
      .mockRejectedValueOnce(new Error("readiness poll failed"))
      .mockResolvedValueOnce([pending])
      .mockResolvedValueOnce([{ ...pending, status: "ready" }]),
    deleteCheckpoint: vi.fn().mockResolvedValue(undefined),
  };
  const provider = new OpenComputerSandboxProvider(client as unknown as OpenComputerRestClient, {
    scmProvider: "github",
    sandboxAccessPasswordSecret: "test-secret",
  });
  const capture = expect(
    provider.takeSnapshot({
      providerObjectId: "sb-canary",
      sessionId: "canary",
      reason: "shutdown_canary",
    })
  ).rejects.toThrow("Failed to checkpoint OpenComputer sandbox");
  await vi.advanceTimersByTimeAsync(1_000);
  await capture;
  const stopSandbox = vi.fn().mockResolvedValue({ success: true });
  const cleanup = cleanupOpenComputerCanary(client, { stopSandbox }, ["sb-canary"], "canary");
  await vi.advanceTimersByTimeAsync(1_000);
  await cleanup;
  expect(client.deleteCheckpoint).toHaveBeenCalledWith(
    "sb-canary",
    "cp-unknown",
    expect.any(AbortSignal)
  );
  expect(stopSandbox).toHaveBeenCalledWith(
    expect.objectContaining({ providerObjectId: "sb-canary", intent: "destroy" })
  );
  expect(client.deleteCheckpoint.mock.invocationCallOrder[0]).toBeLessThan(
    stopSandbox.mock.invocationCallOrder[0]
  );
});

it("still destroys canary sandboxes and reports checkpoint discovery errors", async () => {
  const client = {
    listCheckpoints: vi.fn().mockRejectedValue(new Error("discovery failed")),
    deleteCheckpoint: vi.fn(),
  };
  const stopSandbox = vi.fn().mockResolvedValue({ success: true });
  await expect(
    cleanupOpenComputerCanary(client, { stopSandbox }, ["sb-canary"], "canary")
  ).rejects.toThrow("OpenComputer canary cleanup failed");
  expect(stopSandbox).toHaveBeenCalledOnce();
});
