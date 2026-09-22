import { describe, expect, it, vi } from "vitest";
import { SandboxLaunchRejectedError } from "../provider";
import { createAlarmFixture, createMockProvider, createMockSandbox } from "./test-helpers";

describe("rejected provider allocation", () => {
  it.each([
    [false, "sb-rejected"],
    [true, "sb-rejected"],
    ["expired", "sb-rejected"],
    [false, null],
    [true, null],
    ["expired", null],
  ] as const)(
    "retains cleanup identity and fences the rejected generation (early bridge=%s, cleanup handle=%s)",
    async (earlyBridge, cleanupHandle) => {
      const sandbox = createMockSandbox({ status: "pending", modal_object_id: null });
      const provider = createMockProvider({
        capabilities: { supportsExplicitStop: true },
        createSandbox: async () => {
          if (earlyBridge) {
            sandbox.status = earlyBridge === "expired" ? "failed" : "connecting";
            if (earlyBridge === "expired") sandbox.fenced = 1;
            vi.mocked(fixture.wsManager.getSandboxWebSocket).mockReturnValue({} as WebSocket);
          }
          throw new SandboxLaunchRejectedError("incompatible allocation", cleanupHandle);
        },
      });
      const fixture = createAlarmFixture(sandbox, provider);
      await fixture.manager.spawnSandbox();
      expect(sandbox.status).toBe("failed");
      expect(sandbox.fenced).toBe(1);
      expect(sandbox.auth_token_hash).toBe("");
      expect(sandbox.modal_object_id).toBe(cleanupHandle);
      expect(fixture.wsManager.detachSandboxWebSocket).toHaveBeenCalled();
    }
  );
  it("retains rejected cleanup responsibility across restart and failed retirement", async () => {
    const sandbox = createMockSandbox({ status: "pending", modal_object_id: null });
    const provider = createMockProvider({
      capabilities: { supportsExplicitStop: true },
      createSandbox: vi.fn(async () => {
        throw new SandboxLaunchRejectedError("incompatible", "sb-rejected");
      }),
      stopSandbox: vi.fn(async () => {
        throw new Error("provider unavailable");
      }),
    });
    await createAlarmFixture(sandbox, provider).manager.spawnSandbox();
    const rejectedGeneration = sandbox.modal_sandbox_id;
    const restarted = createAlarmFixture(sandbox, provider);
    await restarted.manager.spawnSandbox();
    await restarted.manager.spawnSandbox();
    expect(sandbox.modal_object_id).toBe("sb-rejected");
    expect(sandbox.modal_sandbox_id).toBe(rejectedGeneration);
    expect(sandbox.fenced).toBe(1);
    expect(provider.createSandbox).toHaveBeenCalledTimes(1);
  });
});
