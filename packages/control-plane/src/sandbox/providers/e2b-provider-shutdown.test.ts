import { beforeEach, describe, expect, it, vi } from "vitest";
import { E2BSandboxProvider } from "./e2b-provider";
import type { E2BSandboxDetail } from "../e2b-rest-client";
import { E2BConflictError, E2BNotFoundError } from "../e2b-rest-client";
import { baseCreateConfig, mockClient, providerConfig } from "./e2b-provider.test-helpers";

describe("E2BSandboxProvider graceful shutdown", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns created ownership with unknown lifetime when the post-start metadata read fails", async () => {
    const client = mockClient({
      getSandbox: vi.fn(async () => {
        throw new Error("metadata unavailable");
      }),
    });
    const result = await new E2BSandboxProvider(client, providerConfig).createSandbox(
      baseCreateConfig
    );
    expect(result).toMatchObject({
      providerObjectId: "e2b-id",
      lifetime: { kind: "unknown", reason: "Failed to read E2B lifetime after successful create" },
    });
    expect(result.lifetime?.observedAtMs).toEqual(expect.any(Number));
    expect(client.startProcess).toHaveBeenCalled();
    expect(client.killSandbox).not.toHaveBeenCalled();
  });

  it("re-reads endAt after resume and verifies an explicit preserve pause", async () => {
    const getSandbox = vi
      .fn()
      .mockResolvedValueOnce({ sandboxID: "e2b-id", templateID: "tmpl", state: "paused" })
      .mockResolvedValueOnce({
        sandboxID: "e2b-id",
        templateID: "tmpl",
        state: "running",
        endAt: "2031-02-03T04:05:06.000Z",
      })
      .mockResolvedValueOnce({ sandboxID: "e2b-id", templateID: "tmpl", state: "paused" });
    const client = mockClient({ getSandbox });
    const provider = new E2BSandboxProvider(client, providerConfig);
    const resumed = await provider.resumeSandbox({
      providerObjectId: "e2b-id",
      sessionId: "sess-1",
      sandboxId: "sandbox-logical",
    });
    expect(resumed.lifetime).toMatchObject({
      kind: "finite",
      expiresAtMs: Date.parse("2031-02-03T04:05:06.000Z"),
      source: "provider",
    });
    await expect(
      provider.stopSandbox({
        providerObjectId: "e2b-id",
        sessionId: "sess-1",
        reason: "final_preservation",
        intent: "preserve",
        deadlineAtMs: Date.now() + 60_000,
      })
    ).resolves.toEqual({ success: true });
    expect(client.pauseSandbox).toHaveBeenCalled();
    expect(getSandbox).toHaveBeenCalledTimes(3);
  });

  it("returns resumed ownership with unknown lifetime when the post-resume metadata read fails", async () => {
    const getSandbox = vi
      .fn()
      .mockResolvedValueOnce({ sandboxID: "e2b-id", templateID: "tmpl", state: "paused" })
      .mockRejectedValueOnce(new Error("metadata unavailable"));
    const client = mockClient({ getSandbox });
    const result = await new E2BSandboxProvider(client, providerConfig).resumeSandbox({
      providerObjectId: "e2b-id",
      sessionId: "sess-1",
      sandboxId: "sandbox-logical",
    });
    expect(result).toMatchObject({
      success: true,
      providerObjectId: "e2b-id",
      lifetime: { kind: "unknown", reason: "Failed to read E2B lifetime after successful resume" },
    });
    expect(result.lifetime?.observedAtMs).toEqual(expect.any(Number));
    expect(client.connectSandbox).toHaveBeenCalledWith("e2b-id", 1800);
  });

  it("stopSandbox pauses resumable sandboxes instead of killing them", async () => {
    const client = mockClient();
    await expect(
      new E2BSandboxProvider(client, providerConfig).stopSandbox({
        providerObjectId: "x",
        sessionId: "s",
        reason: "idle",
        intent: "preserve",
      })
    ).resolves.toEqual({ success: true });
    expect(client.pauseSandbox).toHaveBeenCalledWith("x");
    expect(client.killSandbox).not.toHaveBeenCalled();
  });

  it("does not claim graceful shutdown when the sandbox is missing", async () => {
    const client = mockClient({
      pauseSandbox: vi.fn(async () => {
        throw new E2BNotFoundError("gone");
      }),
    });
    await expect(
      new E2BSandboxProvider(client, providerConfig).stopSandbox({
        providerObjectId: "x",
        sessionId: "s",
        reason: "snapshot",
        intent: "preserve",
      })
    ).resolves.toMatchObject({ success: false });
  });

  it("verifies a pause conflict under the graceful shutdown deadline signal", async () => {
    const client = mockClient({
      pauseSandbox: vi.fn(async () => {
        throw new E2BConflictError("already transitioning");
      }),
    });
    const signal = AbortSignal.timeout(1_000);
    await expect(
      new E2BSandboxProvider(client, providerConfig).stopSandbox({
        providerObjectId: "x",
        sessionId: "s",
        reason: "snapshot",
        intent: "preserve",
        signal,
      })
    ).resolves.toEqual({ success: true });
    expect(client.getSandbox).toHaveBeenCalledWith("x", signal);
  });

  it("rejects a pause conflict unless the sandbox is verified paused", async () => {
    const client = mockClient({
      pauseSandbox: vi.fn(async () => {
        throw new E2BConflictError("already transitioning");
      }),
      getSandbox: vi.fn(
        async (): Promise<E2BSandboxDetail> => ({
          sandboxID: "x",
          templateID: "tmpl",
          state: "running",
        })
      ),
    });
    await expect(
      new E2BSandboxProvider(client, providerConfig).stopSandbox({
        providerObjectId: "x",
        sessionId: "s",
        reason: "snapshot",
        intent: "preserve",
      })
    ).resolves.toMatchObject({ success: false });
  });

  it("forwards the caller signal when killing a replaced sandbox", async () => {
    const client = mockClient();
    const signal = AbortSignal.timeout(1_000);
    await new E2BSandboxProvider(client, providerConfig).stopSandbox({
      providerObjectId: "x",
      sessionId: "s",
      reason: "respawn",
      intent: "destroy",
      signal,
    });
    expect(client.killSandbox).toHaveBeenCalledWith("x", signal);
  });
});
