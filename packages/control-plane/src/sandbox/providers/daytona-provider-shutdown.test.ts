import { describe, expect, it, vi } from "vitest";
import { DaytonaNotFoundError, type DaytonaRestClient } from "../daytona-rest-client";
import type { StopConfig } from "../provider";
import { DaytonaSandboxProvider } from "./daytona-provider";

const stopConfig: StopConfig = {
  providerObjectId: "daytona-sandbox-id",
  sessionId: "session-123",
  reason: "inactivity_timeout",
  intent: "preserve",
};

function createProvider(client: Partial<DaytonaRestClient>): DaytonaSandboxProvider {
  return new DaytonaSandboxProvider(client as DaytonaRestClient, {
    scmProvider: "github",
    sandboxAccessPasswordSecret: "test-secret-key",
  });
}

describe("DaytonaSandboxProvider graceful shutdown", () => {
  it("verifies retained state under the deadline signal", async () => {
    const client = {
      stopSandbox: vi.fn(async () => {}),
      getSandbox: vi.fn(async () => ({
        id: "daytona-sandbox-id",
        state: "stopped" as const,
      })),
    };
    const provider = createProvider(client);

    await expect(
      provider.stopSandbox({ ...stopConfig, deadlineAtMs: Date.now() + 60_000 })
    ).resolves.toEqual({ success: true });
    expect(client.stopSandbox).toHaveBeenCalledWith("daytona-sandbox-id", expect.any(AbortSignal));
    expect(client.getSandbox).toHaveBeenCalledWith("daytona-sandbox-id", expect.any(AbortSignal));
  });

  it("does not claim graceful shutdown when the sandbox is missing", async () => {
    const client = {
      stopSandbox: vi.fn(async () => {
        throw new DaytonaNotFoundError("not found");
      }),
      getSandbox: vi.fn(),
    };
    const provider = createProvider(client);

    await expect(provider.stopSandbox(stopConfig)).resolves.toMatchObject({ success: false });
  });
});
