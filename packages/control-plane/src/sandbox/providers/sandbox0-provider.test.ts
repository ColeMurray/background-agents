import { describe, expect, it, vi } from "vitest";
import {
  SANDBOX0_PAUSE_POLL_INTERVAL_MS,
  SANDBOX0_PAUSE_TIMEOUT_MS,
  Sandbox0SandboxProvider,
} from "./sandbox0-provider";
import { Sandbox0ApiError, Sandbox0RestClient } from "../sandbox0-rest-client";
import { PrebuiltImageUnavailableError } from "../provider";
import { createSandboxProviderFromEnv } from "../provider-factory";
import { resolveSandboxBackendName } from "../provider-name";
import { resolveImageBuildProvider } from "../../image-builds/provider-policy";
import type { Env } from "../../types";

const create = {
  sessionId: "session",
  sandboxId: "logical",
  repoOwner: null,
  repoName: null,
  controlPlaneUrl: "https://cp.test",
  sandboxAuthToken: "bridge-secret",
  harness: "opencode" as const,
  provider: "anthropic",
  model: "claude",
  codeServerEnabled: true,
  vncEnabled: true,
  sandboxSettings: { tunnelPorts: [3000, 3000, 5900] },
  timeoutSeconds: 900,
};
const resume = { ...create, providerObjectId: "physical" };
const services = {
  services: [8080, 6080, 3000].map((port) => ({
    id: `oi-${port}`,
    port,
    public_url: `https://port-${port}.test`,
    publishable: false,
  })),
};
/** Exercise the real provider while keeping all allocation and runtime calls in a transport spy. */
function fixture() {
  const client = new Sandbox0RestClient({ apiKey: "api-secret" });
  const request = vi.spyOn(client, "request");
  return {
    request,
    provider: new Sandbox0SandboxProvider(client, {
      templateId: "verified-template",
      scmProvider: "github",
      sandboxAccessPasswordSecret: "password-seed",
    }),
  };
}
/** Model persisted runtime identity and installed passwords independently of the current API key. */
const runtime = (phase = "stopped") => ({
  id: "runtime",
  phase,
  spec: {
    name: "openinspect-runtime",
    command: ["/opt/openinspect/start-runtime"],
    cwd: "/workspace",
    env: {
      SANDBOX_ID: "logical",
      SANDBOX_AUTH_TOKEN: "bridge-secret",
      CODE_SERVER_PASSWORD: "original",
      VNC_PASSWORD: "vnc",
    },
    lifecycle: { desired_state: "stopped", runtime_recovery: "stop", restart: { policy: "never" } },
  },
});
describe("Sandbox0SandboxProvider", () => {
  it("creates a durable workspace and supervised runtime with protected configuration", async () => {
    const { request, provider } = fixture();
    request
      .mockResolvedValueOnce({ sandbox_id: "physical" })
      .mockResolvedValueOnce(services)
      .mockResolvedValueOnce({});
    const result = await provider.createSandbox({
      ...create,
      userEnvVars: { SANDBOX_ID: "evil", RESTORED_FROM_SNAPSHOT: "true", TERMINAL_ENABLED: "1" },
    });
    expect(result).toMatchObject({
      sandboxId: "logical",
      providerObjectId: "physical",
      codeServerUrl: "https://port-8080.test",
      tunnelUrls: { "3000": "https://port-3000.test" },
    });
    expect(result.vncAccess).toBeDefined();
    expect(request.mock.calls[0][2]).toEqual({
      template: "verified-template",
      config: {
        ttl: 900,
        hard_ttl: 0,
        auto_resume: false,
        services: [3000, 8080, 6080].map((port) => ({
          id: `oi-${port}`,
          port,
          runtime: { type: "manual" },
          ingress: { public: true, routes: [{ id: "default", path_prefix: "/", resume: false }] },
        })),
      },
    });
    expect(request.mock.calls[2]).toEqual([
      "POST",
      "/api/v1/sandboxes/physical/sessions",
      expect.objectContaining({
        env: expect.objectContaining({
          SANDBOX_ID: "logical",
          SANDBOX_AUTH_TOKEN: "bridge-secret",
          TERMINAL_ENABLED: "",
        }),
        lifecycle: {
          desired_state: "running",
          runtime_recovery: "stop",
          restart: { policy: "never" },
        },
      }),
      { idempotencyKey: "openinspect-runtime" },
    ]);
    expect(JSON.stringify(request.mock.calls)).not.toContain("api-secret");
    expect(JSON.stringify(request.mock.calls)).not.toContain("RESTORED_FROM_SNAPSHOT");
  });
  it("cleans up a claimed workspace if runtime startup fails", async () => {
    const { request, provider } = fixture();
    request
      .mockResolvedValueOnce({ sandbox_id: "physical" })
      .mockResolvedValueOnce(services)
      .mockRejectedValueOnce(new Sandbox0ApiError(503, "unavailable", "/sessions"))
      .mockResolvedValueOnce({});
    await expect(provider.createSandbox(create)).rejects.toMatchObject({ errorType: "transient" });
    expect(request).toHaveBeenLastCalledWith("DELETE", "/api/v1/sandboxes/physical", undefined, {
      signal: undefined,
    });
  });
  it("resumes in place with restore boot mode and preserves installed passwords after key rotation", async () => {
    const { request, provider } = fixture();
    request
      .mockResolvedValueOnce({ status: "paused" })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ sessions: [runtime()] })
      .mockResolvedValueOnce(services)
      .mockResolvedValueOnce({});
    await expect(provider.resumeSandbox(resume)).resolves.toMatchObject({
      success: true,
      providerObjectId: "physical",
      codeServerPassword: "original",
    });
    expect(request.mock.calls[2]).toEqual(["POST", "/api/v1/sandboxes/physical/resume"]);
    expect(request.mock.calls[5]).toEqual([
      "PUT",
      "/api/v1/sandboxes/physical/sessions/runtime",
      expect.objectContaining({
        env: expect.objectContaining({
          RESTORED_FROM_SNAPSHOT: "true",
          SANDBOX_AUTH_TOKEN: "bridge-secret",
          SANDBOX_TIMEOUT_SECONDS: "900",
        }),
        lifecycle: expect.objectContaining({ desired_state: "running" }),
      }),
    ]);
  });
  it("does not replace an already running attempt on a retried resume", async () => {
    const { request, provider } = fixture();
    request
      .mockResolvedValueOnce({ status: "running" })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ sessions: [runtime("running")] })
      .mockResolvedValueOnce(services);
    await provider.resumeSandbox(resume);
    expect(request).toHaveBeenCalledTimes(4);
  });
  it("only falls back to fresh creation on an authoritative workspace 404", async () => {
    const { request, provider } = fixture();
    request.mockRejectedValueOnce(new Sandbox0ApiError(404, "not_found", "/sandbox"));
    await expect(provider.resumeSandbox(resume)).resolves.toMatchObject({ shouldSpawnFresh: true });
    request.mockRejectedValueOnce(new Sandbox0ApiError(503, "unavailable", "/sandbox"));
    await expect(provider.resumeSandbox(resume)).rejects.toThrow();
    request
      .mockResolvedValueOnce({ status: "running" })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ sessions: [] });
    await expect(provider.resumeSandbox(resume)).rejects.toThrow("Sandbox0 operation failed");
  });
  it.each(["inactivity_timeout", "heartbeat_timeout"])("checkpoints on %s", async (reason) => {
    const { request, provider } = fixture();
    request.mockResolvedValue({ paused: true });
    await expect(provider.stopSandbox({ ...resume, reason })).resolves.toEqual({ success: true });
    expect(request).toHaveBeenCalledWith("POST", "/api/v1/sandboxes/physical/pause", undefined, {
      signal: expect.any(AbortSignal),
    });
  });
  it("does not report an accepted but unfinished pause as complete", async () => {
    const { request, provider } = fixture();
    request.mockResolvedValueOnce({ paused: false }).mockResolvedValueOnce({ status: "paused" });
    await expect(
      provider.stopSandbox({ ...resume, reason: "inactivity_timeout" })
    ).resolves.toEqual({ success: true });
    expect(request.mock.calls[1][0]).toBe("GET");
  });
  it.each([
    ["default abort", undefined],
    ["custom error", new Error("Stop cancelled by caller")],
    ["primitive reason", "stop cancelled"],
    ["null reason", null],
  ])("preserves the caller's %s while waiting for a checkpoint", async (_label, abortReason) => {
    const { request, provider } = fixture();
    const controller = new AbortController();
    request.mockImplementation(async () => {
      controller.abort(abortReason);
      return { paused: false };
    });
    await expect(
      provider.stopSandbox({ ...resume, reason: "inactivity_timeout", signal: controller.signal })
    ).rejects.toBe(controller.signal.reason);
  });
  it.each(["inactivity_timeout", "heartbeat_timeout", "respawn"])(
    "preserves cancellation during the provider request for %s",
    async (reason) => {
      const { provider } = fixture();
      const controller = new AbortController();
      const abortReason = new Error("Caller no longer needs this stop");
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: string, init: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init.signal!.addEventListener("abort", () => reject(init.signal!.reason), {
                once: true,
              });
            })
        )
      );
      try {
        const assertion = expect(
          provider.stopSandbox({ ...resume, reason, signal: controller.signal })
        ).rejects.toBe(abortReason);
        controller.abort(abortReason);
        await assertion;
      } finally {
        vi.unstubAllGlobals();
      }
    }
  );
  it("cancels the polling delay without leaving timers or issuing another request", async () => {
    vi.useFakeTimers();
    try {
      const { request, provider } = fixture();
      const controller = new AbortController();
      const abortReason = new Error("Resume superseded the idle stop");
      request.mockResolvedValueOnce({ paused: false }).mockResolvedValue({ status: "running" });
      const assertion = expect(
        provider.stopSandbox({
          ...resume,
          reason: "inactivity_timeout",
          signal: controller.signal,
        })
      ).rejects.toBe(abortReason);
      await vi.advanceTimersByTimeAsync(SANDBOX0_PAUSE_POLL_INTERVAL_MS - 1);
      expect(request).toHaveBeenCalledTimes(2);
      controller.abort(abortReason);
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(SANDBOX0_PAUSE_POLL_INTERVAL_MS);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([
    [new Sandbox0ApiError(401, "unauthorized", "/sandbox"), "permanent"],
    [new Sandbox0ApiError(503, "unavailable", "/sandbox"), "transient"],
    [new TypeError("fetch failed"), "transient"],
  ])("still classifies provider failure %s as %s", async (error, errorType) => {
    const { request, provider } = fixture();
    const controller = new AbortController();
    request.mockImplementation(async () => {
      // A late caller abort must not replace an unrelated provider failure.
      controller.abort(new Error("Unrelated cancellation"));
      throw error;
    });
    await expect(
      provider.stopSandbox({ ...resume, reason: "inactivity_timeout", signal: controller.signal })
    ).rejects.toMatchObject({ name: "SandboxProviderError", errorType, cause: error });
  });
  it("waits through a quiescing carrier's failed projection until pause commits", async () => {
    vi.useFakeTimers();
    try {
      const { request, provider } = fixture();
      request
        .mockResolvedValueOnce({ paused: false })
        .mockResolvedValueOnce({ status: "failed" })
        .mockResolvedValueOnce({ status: "paused" });
      const result = provider.stopSandbox({ ...resume, reason: "inactivity_timeout" });
      await vi.advanceTimersByTimeAsync(SANDBOX0_PAUSE_POLL_INTERVAL_MS - 1);
      expect(request).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toEqual({ success: true });
      expect(request).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
  it("bounds an unfinished checkpoint by a deadline", async () => {
    vi.useFakeTimers();
    try {
      const { request, provider } = fixture();
      request.mockResolvedValue({ paused: false, status: "starting" });
      const assertion = expect(
        provider.stopSandbox({ ...resume, reason: "inactivity_timeout" })
      ).rejects.toMatchObject({ errorType: "transient" });
      await vi.advanceTimersByTimeAsync(SANDBOX0_PAUSE_TIMEOUT_MS);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(["respawn", "connecting_timeout", "boot_budget_exceeded", "fatal_runtime_error"])(
    "deletes failed workspaces on %s",
    async (reason) => {
      const { request, provider } = fixture();
      request.mockResolvedValue({});
      await provider.stopSandbox({ ...resume, reason });
      expect(request.mock.calls[0][0]).toBe("DELETE");
    }
  );
  it("treats deletion of an already removed sandbox as success", async () => {
    const { request, provider } = fixture();
    request.mockRejectedValue(new Sandbox0ApiError(404, "not_found", "/sandbox"));
    await expect(provider.stopSandbox({ ...resume, reason: "respawn" })).resolves.toEqual({
      success: true,
    });
  });
  it("declares capability boundaries and rejects prebuilt images before allocation", async () => {
    const { request, provider } = fixture();
    expect(provider.capabilities).toMatchObject({
      supportsPersistentResume: true,
      supportsSnapshots: false,
      supportsRestore: false,
    });
    await expect(
      provider.createSandbox({ ...create, prebuiltImageId: "unsupported" })
    ).rejects.toBeInstanceOf(PrebuiltImageUnavailableError);
    expect(request).not.toHaveBeenCalled();
    expect(resolveImageBuildProvider("sandbox0")).toBeNull();
  });
  it("is available through the composition factory, with required configuration validation", () => {
    expect(resolveSandboxBackendName(" SANDBOX0 ")).toBe("sandbox0");
    expect(() => createSandboxProviderFromEnv({ SANDBOX_PROVIDER: "sandbox0" } as Env)).toThrow(
      "SANDBOX0_API_KEY"
    );
    expect(
      createSandboxProviderFromEnv({
        SANDBOX_PROVIDER: "sandbox0",
        SANDBOX0_API_KEY: "key",
        SANDBOX0_TEMPLATE_ID: "template",
      } as Env).name
    ).toBe("sandbox0");
  });
});
