import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeHmacHex } from "@open-inspect/shared/auth";
import { deriveVncPassword } from "../sandbox-env";
import {
  BOAT_LAUNCH_MARKER_PATH,
  BOAT_LAUNCHER_PATH,
  BOAT_SANDBOX_VERSION,
  BOAT_SETUP_SCRIPT,
  boatIdempotencyKey,
} from "../boat-lifecycle";
import { BOAT_TUNNEL_ENV_FILE_PATH, BoatSandboxProvider } from "./boat-provider";
import {
  baseCreateConfig,
  boatSandbox,
  createEnv,
  mockClient,
  providerConfig,
  createProvider,
  fastTimings,
} from "./boat-provider.test-helpers";
import { PrebuiltImageUnavailableError, SandboxProviderError } from "../provider";
import {
  BoatApiError,
  BoatCancelledError,
  BoatConflictError,
  BoatNotFoundError,
} from "../boat-rest-client";
import { RequestDeadlineError } from "../request-deadline";

const resumeConfig = {
  providerObjectId: "bx_abcdefgh",
  sessionId: "sess-1",
  sandboxId: "sandbox-logical",
  codeServerEnabled: true,
};

describe("BoatSandboxProvider", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("createSandbox", () => {
    it("deploys from the base snapshot, exposes access and has Boat start the launcher", async () => {
      const client = mockClient();
      const provider = createProvider(client, providerConfig);
      const result = await provider.createSandbox(baseCreateConfig);

      expect(result.sandboxId).toBe("sandbox-logical");
      expect(result.providerObjectId).toBe("bx_abcdefgh");
      expect(result.lifetime).toMatchObject({
        kind: "finite",
        expiresAtMs: Date.parse("2030-01-02T03:04:05.000Z"),
        source: "provider",
      });
      expect(result.codeServerUrl).toBe("https://sub-8080.on.boat.dev");
      expect(result.codeServerPassword).toBe(
        (await computeHmacHex("code-server:sandbox-logical", "secret")).slice(0, 32)
      );
      expect(result.ttydUrl).toBeUndefined();
      expect(result.tunnelUrls).toBeUndefined();

      const [params] = vi.mocked(client.createSandbox).mock.calls[0];
      expect(params).toMatchObject({
        type: "default",
        ttlSeconds: 7200,
        from: "open-inspect-abc123",
        idempotencyKey: await boatIdempotencyKey(
          "test",
          baseCreateConfig.sessionId,
          "sandbox-logical"
        ),
        monitoring: false,
      });
      expect(params).not.toHaveProperty("name");
      expect(client.updateSandbox).toHaveBeenCalledWith("bx_abcdefgh", {
        name: "openinspect-test-sandbox-logical",
      });
      expect(client.hostPort).toHaveBeenCalledWith("bx_abcdefgh", {
        port: 8080,
        public: true,
        title: "code-server",
      });
      // The launch rides on the create: Boat runs the setup script the moment
      // the machine is up, and it execs the launcher once the control plane has
      // released the launch, so no start command follows.
      expect(params.setupScript).toBe(BOAT_SETUP_SCRIPT);
      expect(client.writeFile).toHaveBeenCalledWith("bx_abcdefgh", {
        path: BOAT_LAUNCH_MARKER_PATH,
        content: "released\n",
      });
      expect(client.startDetachedCommand).not.toHaveBeenCalled();
      expect(client.deleteSandbox).not.toHaveBeenCalled();
    });

    it("delivers the session env on create with system vars and boot markers overriding user vars", async () => {
      const client = mockClient();
      await createProvider(client, providerConfig).createSandbox({
        ...baseCreateConfig,
        userEnvVars: {
          SANDBOX_ID: "evil",
          SANDBOX_VERSION: "v0-evil",
          RESTORED_FROM_SNAPSHOT: "true",
          BOAT_ID: "bx_evil",
          ASCII_TOKEN: "evil",
          KEEP_ME: "yes",
        },
      });
      const env = createEnv(client);
      expect(env).toMatchObject({
        SANDBOX_ID: "sandbox-logical",
        SANDBOX_VERSION: BOAT_SANDBOX_VERSION,
        SANDBOX_TIMEOUT_SECONDS: "7200",
        RESTORED_FROM_SNAPSHOT: "false",
        FROM_REPO_IMAGE: "false",
        IMAGE_BUILD_MODE: "false",
        OI_DEFERRED_START: "false",
        KEEP_ME: "yes",
        VCS_HOST: "github.com",
      });
      // Boat refuses its own names: a user secret under one is dropped, not fatal.
      expect(env).not.toHaveProperty("BOAT_ID");
      expect(env).not.toHaveProperty("ASCII_TOKEN");
      // Git auth is brokered per request; no token rides the env.
      expect(env).not.toHaveProperty("VCS_CLONE_TOKEN");
      expect(env).not.toHaveProperty("GITHUB_TOKEN");
    });

    it("defaults noVNC to 6081, keeps tunnels protected and writes the tunnel env file", async () => {
      const client = mockClient();
      const result = await createProvider(client, providerConfig).createSandbox({
        ...baseCreateConfig,
        vncEnabled: true,
        sandboxSettings: { terminalEnabled: true, tunnelPorts: [5173, 3000, 8080] },
      });
      const expectedVnc = await deriveVncPassword("sandbox-logical", "secret");
      expect(createEnv(client)).toMatchObject({
        NOVNC_PORT: "6081",
        VNC_PASSWORD: expectedVnc,
        TERMINAL_ENABLED: "true",
        TTYD_PROXY_PORT: "7680",
        EXPECTED_TUNNEL_PORTS: "5173,3000",
      });
      expect(result.vncAccess).toEqual({
        url: "https://sub-6081.on.boat.dev",
        password: expectedVnc,
      });
      expect(result.ttydUrl).toBe("https://sub-7680.on.boat.dev");
      expect(result.tunnelUrls).toEqual({
        "5173": "https://sub-5173.on.boat.dev?_token=tok5173",
        "3000": "https://sub-3000.on.boat.dev?_token=tok3000",
      });
      expect(client.hostPort).toHaveBeenCalledWith("bx_abcdefgh", {
        port: 6081,
        public: true,
        title: "noVNC",
      });
      expect(client.hostPort).toHaveBeenCalledWith("bx_abcdefgh", {
        port: 3000,
        public: false,
        title: "tunnel 3000",
      });
      expect(client.writeFile).toHaveBeenCalledWith("bx_abcdefgh", {
        path: BOAT_TUNNEL_ENV_FILE_PATH,
        content:
          "TUNNEL_SANDBOX_ID=sandbox-logical\n" +
          "TUNNEL_3000=https://sub-3000.on.boat.dev?_token=tok3000\n" +
          "TUNNEL_5173=https://sub-5173.on.boat.dev?_token=tok5173\n",
      });
      // The tunnel env file is in place before the launch is released, and the
      // launch is released before the first readiness read: the runtime can
      // start neither before the file nor after this side has stopped looking.
      const writes = vi.mocked(client.writeFile).mock;
      const tunnelWrite = writes.calls.findIndex(
        ([, file]) => file.path === BOAT_TUNNEL_ENV_FILE_PATH
      );
      const markerWrite = writes.calls.findIndex(
        ([, file]) => file.path === BOAT_LAUNCH_MARKER_PATH
      );
      expect(writes.invocationCallOrder[tunnelWrite]).toBeLessThan(
        writes.invocationCallOrder[markerWrite]
      );
      expect(writes.invocationCallOrder[markerWrite]).toBeLessThan(
        vi.mocked(client.getSandbox).mock.invocationCallOrder[0]
      );
    });

    it("leaves a personal sandbox alone and makes a shared organization sandbox private first", async () => {
      const personal = mockClient();
      await createProvider(personal).createSandbox(baseCreateConfig);
      expect(personal.unshareSandbox).not.toHaveBeenCalled();

      const shared = mockClient({
        createSandbox: vi.fn(async () =>
          boatSandbox({ state: "provisioning", visibility: "shared" })
        ),
      });
      const result = await createProvider(shared).createSandbox(baseCreateConfig);
      expect(result.providerObjectId).toBe("bx_abcdefgh");
      expect(shared.unshareSandbox).toHaveBeenCalledWith("bx_abcdefgh");
      // Private before anything else happens to the sandbox.
      const unshareOrder = vi.mocked(shared.unshareSandbox).mock.invocationCallOrder[0];
      expect(unshareOrder).toBeLessThan(vi.mocked(shared.getSandbox).mock.invocationCallOrder[0]);
      expect(unshareOrder).toBeLessThan(vi.mocked(shared.hostPort).mock.invocationCallOrder[0]);
      // And the launch is released only after that.
      expect(unshareOrder).toBeLessThan(vi.mocked(shared.writeFile).mock.invocationCallOrder[0]);
    });

    it("deletes a shared organization sandbox it cannot make private", async () => {
      const client = mockClient({
        createSandbox: vi.fn(async () =>
          boatSandbox({ state: "provisioning", visibility: "shared" })
        ),
        unshareSandbox: vi.fn(async () => boatSandbox({ visibility: "shared" })),
      });
      const error = await createProvider(client)
        .createSandbox(baseCreateConfig)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SandboxProviderError);
      expect((error as SandboxProviderError).errorType).toBe("permanent");
      expect((error as SandboxProviderError).message).toContain("stayed shared");
      expect(client.deleteSandbox).toHaveBeenCalledWith("bx_abcdefgh");
      expect(client.startDetachedCommand).not.toHaveBeenCalled();
      // No launch marker: the setup script never execs the launcher.
      expect(client.writeFile).not.toHaveBeenCalled();
    });

    it("fails the create and deletes the sandbox when the launch cannot be released", async () => {
      const client = mockClient({
        writeFile: vi.fn(async () => {
          throw new BoatApiError("agent unavailable", 503);
        }),
      });
      const error = await createProvider(client, providerConfig)
        .createSandbox(baseCreateConfig)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SandboxProviderError);
      expect(client.writeFile).toHaveBeenCalledTimes(3);
      expect(client.getSandbox).not.toHaveBeenCalled();
      expect(client.deleteSandbox).toHaveBeenCalledWith("bx_abcdefgh");
    });

    it("keeps a failed dashboard label from failing the create", async () => {
      const client = mockClient({
        updateSandbox: vi.fn(async () => {
          throw new BoatApiError("busy", 409, "sandbox_busy");
        }),
      });
      const result = await createProvider(client).createSandbox(baseCreateConfig);
      expect(result.providerObjectId).toBe("bx_abcdefgh");
      expect(client.deleteSandbox).not.toHaveBeenCalled();
    });

    it("keeps a failed access route from hiding the live sandbox", async () => {
      const client = mockClient({
        hostPort: vi.fn(async () => {
          throw new BoatApiError("route failed", 500);
        }),
      });
      const result = await createProvider(client, providerConfig).createSandbox(baseCreateConfig);
      expect(result.providerObjectId).toBe("bx_abcdefgh");
      expect(result.codeServerUrl).toBeUndefined();
      expect(client.deleteSandbox).not.toHaveBeenCalled();
    });

    it("selects the smallest machine type that fits the requested resources", async () => {
      const client = mockClient();
      await createProvider(client, providerConfig).createSandbox({
        ...baseCreateConfig,
        sandboxSettings: { cpuCores: 6 },
      });
      expect(vi.mocked(client.createSandbox).mock.calls[0][0].type).toBe("large");
    });

    it("rejects a port Boat holds before creating anything", async () => {
      const client = mockClient();
      const error = await createProvider(client, providerConfig)
        .createSandbox({ ...baseCreateConfig, sandboxSettings: { tunnelPorts: [8090] } })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SandboxProviderError);
      expect((error as SandboxProviderError).errorType).toBe("permanent");
      expect((error as SandboxProviderError).message).toContain("8090");
      expect(client.createSandbox).not.toHaveBeenCalled();
    });

    it("clamps the lifetime to Boat's auto-stop bounds", async () => {
      const client = mockClient();
      await createProvider(client, providerConfig).createSandbox({
        ...baseCreateConfig,
        timeoutSeconds: 10_000_000,
      });
      expect(vi.mocked(client.createSandbox).mock.calls[0][0].ttlSeconds).toBe(2_592_000);
      expect(createEnv(client).SANDBOX_TIMEOUT_SECONDS).toBe("2592000");
    });

    it("repeats a create whose response was lost under the same idempotency key", async () => {
      const createSandbox = vi
        .fn()
        .mockRejectedValueOnce(new BoatApiError("upstream", 503))
        .mockResolvedValueOnce(boatSandbox({ state: "provisioning" }));
      const client = mockClient({ createSandbox });
      await createProvider(client, providerConfig).createSandbox(baseCreateConfig);
      expect(createSandbox).toHaveBeenCalledTimes(2);
      expect(createSandbox.mock.calls[0][0].idempotencyKey).toBe(
        createSandbox.mock.calls[1][0].idempotencyKey
      );
    });

    it("does not retry a start-rate limit and classifies it transient", async () => {
      const client = mockClient({
        createSandbox: vi.fn(async () => {
          throw new BoatApiError("rate limited", 429, "rate_limited");
        }),
      });
      const error = await createProvider(client, providerConfig)
        .createSandbox(baseCreateConfig)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SandboxProviderError);
      expect((error as SandboxProviderError).errorType).toBe("transient");
      expect(client.createSandbox).toHaveBeenCalledTimes(1);
      expect(client.deleteSandbox).not.toHaveBeenCalled();
    });

    it("deletes the sandbox and fails permanently when Boat reports the launcher failed", async () => {
      const client = mockClient({
        getSandbox: vi.fn(async () =>
          boatSandbox({
            setupStatus: "failed",
            setupError: "exit code 1: runtime toolchain missing",
          })
        ),
      });
      const error = await createProvider(client, providerConfig)
        .createSandbox(baseCreateConfig)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SandboxProviderError);
      expect((error as SandboxProviderError).errorType).toBe("permanent");
      expect((error as SandboxProviderError).message).toContain("exit code 1");
      expect((error as SandboxProviderError).message).toContain("runtime toolchain missing");
      expect(client.deleteSandbox).toHaveBeenCalledWith("bx_abcdefgh");
    });

    it("still catches a launcher that exits just after the readiness read", async () => {
      const client = mockClient({
        getSandbox: vi
          .fn()
          .mockResolvedValueOnce(boatSandbox({ setupStatus: "running" }))
          .mockResolvedValueOnce(boatSandbox({ setupStatus: "running" }))
          .mockResolvedValue(
            boatSandbox({ setupStatus: "failed", setupError: "exit code 1: bad launcher" })
          ),
      });
      // A wide enough settle window for the watch to read more than once.
      const provider = new BoatSandboxProvider(client, providerConfig, {
        ...fastTimings,
        launchSettleMs: 200,
      });
      const error = await provider.createSandbox(baseCreateConfig).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SandboxProviderError);
      expect((error as SandboxProviderError).message).toContain("bad launcher");
      expect(client.deleteSandbox).toHaveBeenCalledWith("bx_abcdefgh");
    });

    it("treats a setup script that is still running as a healthy launch", async () => {
      const client = mockClient({
        getSandbox: vi.fn(async () => boatSandbox({ setupStatus: "running" })),
      });
      const result = await createProvider(client, providerConfig).createSandbox(baseCreateConfig);
      expect(result.providerObjectId).toBe("bx_abcdefgh");
      expect(client.startDetachedCommand).not.toHaveBeenCalled();
      expect(client.deleteSandbox).not.toHaveBeenCalled();
    });

    it("deletes a sandbox that ends in error while provisioning", async () => {
      const client = mockClient({
        getSandbox: vi.fn(async () => boatSandbox({ state: "error", error: "no machine" })),
      });
      const error = await createProvider(client, providerConfig)
        .createSandbox(baseCreateConfig)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SandboxProviderError);
      expect((error as SandboxProviderError).errorType).toBe("permanent");
      expect((error as SandboxProviderError).message).toContain("no machine");
      expect(client.deleteSandbox).toHaveBeenCalledWith("bx_abcdefgh");
      expect(client.startDetachedCommand).not.toHaveBeenCalled();
    });

    it("reports a lifetime of none when Boat disables auto-stop and unknown when it is unreadable", async () => {
      const none = await createProvider(
        mockClient({ getSandbox: vi.fn(async () => boatSandbox({ archiveAfter: null })) }),
        providerConfig
      ).createSandbox(baseCreateConfig);
      expect(none.lifetime).toMatchObject({ kind: "none" });
      const unknown = await createProvider(
        mockClient({ getSandbox: vi.fn(async () => boatSandbox({ archiveAfter: undefined })) }),
        providerConfig
      ).createSandbox(baseCreateConfig);
      expect(unknown.lifetime).toMatchObject({ kind: "unknown" });
    });
  });

  describe("resumeSandbox", () => {
    it("spawns fresh when the sandbox is gone from Boat", async () => {
      const client = mockClient({
        getSandbox: vi.fn(async () => {
          throw new BoatNotFoundError("gone");
        }),
      });
      const result = await createProvider(client, providerConfig).resumeSandbox(resumeConfig);
      expect(result).toMatchObject({ success: false, shouldSpawnFresh: true });
      expect(client.resumeSandbox).not.toHaveBeenCalled();
    });

    it("resumes an archived sandbox, re-routes access and restarts the runtime", async () => {
      const getSandbox = vi
        .fn()
        .mockResolvedValueOnce(boatSandbox({ state: "archived", snapshotAvailable: true }))
        .mockResolvedValueOnce(boatSandbox({ state: "provisioned" }))
        .mockResolvedValue(
          boatSandbox({ state: "ready", archiveAfter: "2031-01-01T00:00:00.000Z" })
        );
      const client = mockClient({ getSandbox });
      const result = await createProvider(client, providerConfig).resumeSandbox({
        ...resumeConfig,
        timeoutSeconds: 3600,
        sandboxSettings: { tunnelPorts: [3000] },
      });
      expect(result).toMatchObject({
        success: true,
        providerObjectId: "bx_abcdefgh",
        lifetime: { kind: "finite", expiresAtMs: Date.parse("2031-01-01T00:00:00.000Z") },
        codeServerUrl: "https://sub-8080.on.boat.dev",
        tunnelUrls: { "3000": "https://sub-3000.on.boat.dev?_token=tok3000" },
      });
      expect(client.resumeSandbox).toHaveBeenCalledWith("bx_abcdefgh", { ttlSeconds: 3600 });
      expect(client.updateSandbox).not.toHaveBeenCalled();
      expect(client.writeFile).toHaveBeenCalled();
      expect(client.startDetachedCommand).toHaveBeenCalledWith("bx_abcdefgh", BOAT_LAUNCHER_PATH);
    });

    it("does not fail a resume on a launcher Boat's agent lost track of", async () => {
      const client = mockClient({
        getSandbox: vi
          .fn()
          .mockResolvedValueOnce(boatSandbox({ state: "archived", snapshotAvailable: true }))
          .mockResolvedValue(boatSandbox({ state: "ready" })),
        getCommandStatus: vi.fn(async () => ({
          status: "lost" as const,
          running: false,
          exitCode: null,
          stdout: "",
          stderr: "",
        })),
      });
      const result = await createProvider(client, providerConfig).resumeSandbox(resumeConfig);
      expect(result.success).toBe(true);
      expect(client.deleteSandbox).not.toHaveBeenCalled();
    });

    it("treats a launcher that found the runtime already running as resumed", async () => {
      const client = mockClient({
        getSandbox: vi
          .fn()
          .mockResolvedValueOnce(boatSandbox({ state: "archived", snapshotAvailable: true }))
          .mockResolvedValue(boatSandbox({ state: "ready" })),
        getCommandStatus: vi.fn(async () => ({
          status: "exited" as const,
          running: false,
          exitCode: 75,
          stdout: "",
          stderr: "",
        })),
      });
      const result = await createProvider(client, providerConfig).resumeSandbox(resumeConfig);
      expect(result.success).toBe(true);
      expect(client.deleteSandbox).not.toHaveBeenCalled();
    });

    it("ignores the create-time setup status when resuming", async () => {
      // The create's setup script is long gone by the time a sandbox resumes;
      // a `failed` left behind says nothing about the machine coming up now.
      const client = mockClient({
        getSandbox: vi
          .fn()
          .mockResolvedValueOnce(boatSandbox({ state: "archived", snapshotAvailable: true }))
          .mockResolvedValue(boatSandbox({ state: "ready", setupStatus: "failed" })),
      });
      const result = await createProvider(client, providerConfig).resumeSandbox(resumeConfig);
      expect(result.success).toBe(true);
      expect(client.startDetachedCommand).toHaveBeenCalledWith("bx_abcdefgh", BOAT_LAUNCHER_PATH);
    });

    it("refreshes the deadline of a sandbox that is still running instead of resuming it", async () => {
      const client = mockClient();
      const result = await createProvider(client, providerConfig).resumeSandbox(resumeConfig);
      expect(result.success).toBe(true);
      expect(client.updateSandbox).toHaveBeenCalledWith("bx_abcdefgh", { ttlSeconds: 7200 });
      expect(client.resumeSandbox).not.toHaveBeenCalled();
      expect(client.startDetachedCommand).toHaveBeenCalled();
    });

    it("spawns fresh when Boat has deleted the snapshot data", async () => {
      const expired = mockClient({
        getSandbox: vi.fn(async () =>
          boatSandbox({ state: "archived", dataExpiredAt: "2026-10-01T00:00:00.000Z" })
        ),
      });
      await expect(
        createProvider(expired, providerConfig).resumeSandbox(resumeConfig)
      ).resolves.toMatchObject({ success: false, shouldSpawnFresh: true });
      expect(expired.resumeSandbox).not.toHaveBeenCalled();

      const conflict = mockClient({
        getSandbox: vi.fn(async () => boatSandbox({ state: "archived" })),
        resumeSandbox: vi.fn(async () => {
          throw new BoatConflictError("expired", "snapshot_data_expired");
        }),
      });
      await expect(
        createProvider(conflict, providerConfig).resumeSandbox(resumeConfig)
      ).resolves.toMatchObject({ success: false, shouldSpawnFresh: true });
    });

    it("spawns fresh when the sandbox disappears while it is being brought back", async () => {
      const vanished = mockClient({
        getSandbox: vi
          .fn()
          .mockResolvedValueOnce(boatSandbox({ state: "archived" }))
          .mockRejectedValue(new BoatNotFoundError("gone")),
      });
      await expect(createProvider(vanished).resumeSandbox(resumeConfig)).resolves.toMatchObject({
        success: false,
        shouldSpawnFresh: true,
      });
      expect(vanished.resumeSandbox).toHaveBeenCalled();
      expect(vanished.startDetachedCommand).not.toHaveBeenCalled();

      const cancelled = mockClient({
        getSandbox: vi
          .fn()
          .mockResolvedValueOnce(boatSandbox({ state: "archived" }))
          .mockResolvedValue(boatSandbox({ state: "cancelled", error: "no machine" })),
      });
      await expect(createProvider(cancelled).resumeSandbox(resumeConfig)).resolves.toMatchObject({
        success: false,
        shouldSpawnFresh: true,
      });
    });

    it("spawns fresh when the sandbox vanishes while it is being made private", async () => {
      const client = mockClient({
        getSandbox: vi.fn(async () => boatSandbox({ state: "archived", visibility: "shared" })),
        unshareSandbox: vi.fn(async () => {
          throw new BoatNotFoundError("gone", "sandbox_not_found");
        }),
      });
      await expect(createProvider(client).resumeSandbox(resumeConfig)).resolves.toMatchObject({
        success: false,
        shouldSpawnFresh: true,
      });
      expect(client.resumeSandbox).not.toHaveBeenCalled();
    });

    it("makes a shared organization sandbox private before resuming it", async () => {
      const client = mockClient({
        getSandbox: vi
          .fn()
          .mockResolvedValueOnce(boatSandbox({ state: "archived", visibility: "shared" }))
          .mockResolvedValue(boatSandbox({ state: "ready", visibility: "private" })),
      });
      const result = await createProvider(client).resumeSandbox(resumeConfig);
      expect(result.success).toBe(true);
      expect(client.unshareSandbox).toHaveBeenCalledWith("bx_abcdefgh");
      expect(vi.mocked(client.unshareSandbox).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(client.resumeSandbox).mock.invocationCallOrder[0]
      );
    });

    it("spawns fresh for a cancelled sandbox and surfaces other conflicts", async () => {
      await expect(
        createProvider(
          mockClient({ getSandbox: vi.fn(async () => boatSandbox({ state: "cancelled" })) }),
          providerConfig
        ).resumeSandbox(resumeConfig)
      ).resolves.toMatchObject({ success: false, shouldSpawnFresh: true });

      const busy = mockClient({
        getSandbox: vi.fn(async () => boatSandbox({ state: "archived" })),
        resumeSandbox: vi.fn(async () => {
          throw new BoatConflictError("busy", "sandbox_busy");
        }),
      });
      const error = await createProvider(busy, providerConfig)
        .resumeSandbox(resumeConfig)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SandboxProviderError);
      expect((error as SandboxProviderError).errorType).toBe("permanent");
    });
  });

  describe("stopSandbox", () => {
    const stopConfig = {
      providerObjectId: "bx_abcdefgh",
      sessionId: "sess-1",
      reason: "inactivity_timeout",
    };

    it("archives for preserve and confirms the snapshot", async () => {
      const getSandbox = vi
        .fn()
        .mockResolvedValueOnce(
          boatSandbox({ state: "archiving", stop: { id: "stop_1", status: "pending" } })
        )
        .mockResolvedValue(
          boatSandbox({
            state: "archived",
            snapshotAvailable: true,
            stop: { id: "stop_1", status: "completed" },
          })
        );
      const client = mockClient({ getSandbox });
      const result = await createProvider(client, providerConfig).stopSandbox({
        ...stopConfig,
        intent: "preserve",
        deadlineAtMs: Date.now() + 60_000,
      });
      expect(result).toEqual({ success: true });
      expect(client.stopSandbox).toHaveBeenCalledWith("bx_abcdefgh", expect.any(AbortSignal));
      expect(client.deleteSandbox).not.toHaveBeenCalled();
    });

    it("does not claim an archive whose snapshot is missing", async () => {
      const client = mockClient({
        getSandbox: vi.fn(async () =>
          boatSandbox({
            state: "archived",
            snapshotAvailable: false,
            stop: { id: "stop_1", status: "failing", error: "disk busy" },
          })
        ),
      });
      const result = await createProvider(client, providerConfig).stopSandbox({
        ...stopConfig,
        intent: "preserve",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("disk busy");
    });

    it("accepts a sandbox Boat had already archived with a snapshot", async () => {
      const client = mockClient({
        stopSandbox: vi.fn(async () => {
          throw new BoatApiError("already archived", 400, "stop_failed");
        }),
        getSandbox: vi.fn(async () => boatSandbox({ state: "archived", snapshotAvailable: true })),
      });
      await expect(
        createProvider(client, providerConfig).stopSandbox({
          ...stopConfig,
          intent: "preserve",
        })
      ).resolves.toEqual({ success: true });
    });

    it("does not claim graceful shutdown when the sandbox is missing", async () => {
      const client = mockClient({
        stopSandbox: vi.fn(async () => {
          throw new BoatNotFoundError("gone");
        }),
      });
      await expect(
        createProvider(client, providerConfig).stopSandbox({
          ...stopConfig,
          intent: "preserve",
        })
      ).resolves.toMatchObject({ success: false });
    });

    it("reports a timeout instead of success when the archive outlasts the deadline", async () => {
      const client = mockClient({
        getSandbox: vi.fn(async () =>
          boatSandbox({ state: "archiving", stop: { id: "stop_1", status: "pending" } })
        ),
      });
      const result = await createProvider(client, providerConfig).stopSandbox({
        ...stopConfig,
        intent: "preserve",
        deadlineAtMs: Date.now() + 50,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Timed out");
    });

    it("deletes for destroy and treats a missing sandbox as already gone", async () => {
      const client = mockClient();
      await expect(
        createProvider(client, providerConfig).stopSandbox({
          ...stopConfig,
          intent: "destroy",
        })
      ).resolves.toEqual({ success: true });
      expect(client.deleteSandbox).toHaveBeenCalledWith("bx_abcdefgh", expect.any(AbortSignal));
      expect(client.stopSandbox).not.toHaveBeenCalled();

      const gone = mockClient({
        deleteSandbox: vi.fn(async () => {
          throw new BoatNotFoundError("gone");
        }),
      });
      await expect(
        createProvider(gone, providerConfig).stopSandbox({
          ...stopConfig,
          intent: "destroy",
        })
      ).resolves.toEqual({ success: true });
    });
  });

  describe("prebuilt images", () => {
    it("deploys a session from its prebuilt image and marks the boot", async () => {
      const client = mockClient();
      await createProvider(client, providerConfig).createSandbox({
        ...baseCreateConfig,
        prebuiltImageId: "oi-img-o-r-0123456789abcdef",
        prebuiltImageSha: "abc123",
      });
      const [params] = vi.mocked(client.createSandbox).mock.calls[0];
      expect(params.from).toBe("oi-img-o-r-0123456789abcdef");
      expect(createEnv(client)).toMatchObject({
        FROM_REPO_IMAGE: "true",
        REPO_IMAGE_SHA: "abc123",
        RESTORED_FROM_SNAPSHOT: "false",
        IMAGE_BUILD_MODE: "false",
      });
      expect(params.setupScript).toBe(BOAT_SETUP_SCRIPT);
    });

    it("states FROM_REPO_IMAGE=false and sends no sha for a base-snapshot spawn", async () => {
      const client = mockClient();
      await createProvider(client, providerConfig).createSandbox({
        ...baseCreateConfig,
        userEnvVars: { FROM_REPO_IMAGE: "true", REPO_IMAGE_SHA: "evil" },
      });
      const env = createEnv(client);
      expect(env.FROM_REPO_IMAGE).toBe("false");
      expect(env).not.toHaveProperty("REPO_IMAGE_SHA");
    });

    it("retires an image Boat no longer has instead of failing the session", async () => {
      const client = mockClient({
        createSandbox: vi.fn(async () => {
          throw new BoatNotFoundError("no named snapshot", "snapshot_not_found");
        }),
      });
      const error = await createProvider(client, providerConfig)
        .createSandbox({ ...baseCreateConfig, prebuiltImageId: "oi-img-gone" })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PrebuiltImageUnavailableError);
      expect(client.createSandbox).toHaveBeenCalledTimes(1);
      expect(client.deleteSandbox).not.toHaveBeenCalled();
    });

    it("keeps a 404 on a base-snapshot create an ordinary permanent failure", async () => {
      const client = mockClient({
        createSandbox: vi.fn(async () => {
          throw new BoatNotFoundError("no named snapshot", "snapshot_not_found");
        }),
      });
      const error = await createProvider(client, providerConfig)
        .createSandbox(baseCreateConfig)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SandboxProviderError);
      expect(error).not.toBeInstanceOf(PrebuiltImageUnavailableError);
      expect((error as SandboxProviderError).errorType).toBe("permanent");
    });
  });

  describe("error classification", () => {
    it.each([
      [new BoatApiError("rate limited", 429, "rate_limited"), "transient"],
      [new BoatApiError("server", 500), "transient"],
      [new BoatApiError("unavailable", 503, "out_of_capacity"), "transient"],
      [new BoatApiError("forbidden", 403), "permanent"],
      [new BoatApiError("bad request", 400, "invalid_env"), "permanent"],
      [new BoatConflictError("conflict", "sandbox_busy"), "permanent"],
      [new RequestDeadlineError("boat", "GET /sandboxes/x", 15_000), "transient"],
      [new BoatCancelledError("GET /sandboxes/x"), "transient"],
      [new TypeError("fetch failed"), "transient"],
    ])("classifies %s as %s", async (cause, expected) => {
      const client = mockClient({
        getSandbox: vi.fn(async () => {
          throw cause;
        }),
      });
      const error = await createProvider(client, providerConfig)
        .resumeSandbox(resumeConfig)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SandboxProviderError);
      expect((error as SandboxProviderError).errorType).toBe(expected);
      expect((error as SandboxProviderError).cause).toBe(cause);
    });
  });
});
