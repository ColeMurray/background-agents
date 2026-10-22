import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeHmacHex } from "@open-inspect/shared/auth";
import { deriveVncPassword } from "../sandbox-env";
import {
  assertBoatEnvWithinLimits,
  BOAT_LAUNCHER_PATH,
  BOAT_SANDBOX_VERSION,
  BOAT_TUNNEL_ENV_FILE_PATH,
  boatIdempotencyKey,
  boatImageSnapshotName,
  resolveBoatMachineType,
  resolveBoatTtlSeconds,
} from "./boat-provider";
import {
  baseCreateConfig,
  boatSandbox,
  createEnv,
  mockClient,
  providerConfig,
  createProvider,
} from "./boat-provider.test-helpers";
import { PrebuiltImageUnavailableError, SandboxProviderError } from "../provider";
import {
  BOAT_NAMED_SNAPSHOT_NAME_PATTERN,
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
    it("deploys from the base snapshot, exposes access and starts the launcher", async () => {
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
      expect(client.startDetachedCommand).toHaveBeenCalledWith("bx_abcdefgh", BOAT_LAUNCHER_PATH);
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
      // The tunnel env is in place before the runtime starts and reads it.
      const writeOrder = vi.mocked(client.writeFile).mock.invocationCallOrder[0];
      const launchOrder = vi.mocked(client.startDetachedCommand).mock.invocationCallOrder[0];
      expect(writeOrder).toBeLessThan(launchOrder);
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
    });

    it("keeps a failed dashboard label from failing the create", async () => {
      const client = mockClient({
        updateSandbox: vi.fn(async () => {
          throw new BoatApiError("busy", 409, "sandbox_busy");
        }),
      });
      const result = await createProvider(client).createSandbox(baseCreateConfig);
      expect(result.providerObjectId).toBe("bx_abcdefgh");
      expect(client.startDetachedCommand).toHaveBeenCalled();
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
      expect(client.startDetachedCommand).toHaveBeenCalled();
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

    it("deletes the sandbox and fails permanently when the launcher exits", async () => {
      const client = mockClient({
        getCommandStatus: vi.fn(async () => ({
          status: "exited" as const,
          running: false,
          exitCode: 1,
          stdout: "",
          stderr: "runtime toolchain missing",
        })),
      });
      const error = await createProvider(client, providerConfig)
        .createSandbox(baseCreateConfig)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SandboxProviderError);
      expect((error as SandboxProviderError).errorType).toBe("permanent");
      expect((error as SandboxProviderError).message).toContain("exited with code 1");
      expect((error as SandboxProviderError).message).toContain("runtime toolchain missing");
      expect(client.deleteSandbox).toHaveBeenCalledWith("bx_abcdefgh");
    });

    it("does not fail a boot on a launcher Boat's agent lost track of", async () => {
      const client = mockClient({
        getCommandStatus: vi.fn(async () => ({
          status: "lost" as const,
          running: false,
          exitCode: null,
          stdout: "",
          stderr: "",
        })),
      });
      const result = await createProvider(client).createSandbox(baseCreateConfig);
      expect(result.providerObjectId).toBe("bx_abcdefgh");
      expect(client.deleteSandbox).not.toHaveBeenCalled();
    });

    it("treats a launcher that found the runtime already running as started", async () => {
      const client = mockClient({
        getCommandStatus: vi.fn(async () => ({
          status: "exited" as const,
          running: false,
          exitCode: 75,
          stdout: "",
          stderr: "",
        })),
      });
      const result = await createProvider(client, providerConfig).createSandbox(baseCreateConfig);
      expect(result.providerObjectId).toBe("bx_abcdefgh");
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
      expect(client.startDetachedCommand).toHaveBeenCalledWith("bx_abcdefgh", BOAT_LAUNCHER_PATH);
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

  describe("triggerImageBuild", () => {
    const buildConfig = {
      buildId: "imgb-acme-repo-1757000000000-ab12",
      scopeKind: "repo" as const,
      scopeId: "acme/repo",
      repositories: [{ repoOwner: "acme", repoName: "repo", baseBranch: "main" }],
      callbackUrl: "https://worker.test/image-builds/build-complete",
      failureCallbackUrl: "https://worker.test/image-builds/build-failed",
      callbackToken: "a".repeat(64),
      cloneToken: "clone-token",
      userEnvVars: {
        FOO: "bar",
        BOAT_ID: "evil",
        OI_DEFERRED_START: "true",
        OI_REPO_IMAGE_CALLBACK_URL: "https://evil.test",
      },
      buildExecutionTimeoutSeconds: 1800,
      providerSessionTimeoutSeconds: 2400,
      correlation: { request_id: "request-1", trace_id: "trace-1" },
    };

    it("creates the build sandbox from the base snapshot, binds it, then launches the build", async () => {
      const client = mockClient();
      const order: string[] = [];
      vi.mocked(client.getSandbox).mockImplementation(async () => {
        order.push("ready");
        return boatSandbox();
      });
      vi.mocked(client.startDetachedCommand).mockImplementation(async () => {
        order.push("launch");
        return { processId: 7 };
      });
      const onProviderSessionCreated = vi.fn(async () => {
        order.push("bind");
      });

      await createProvider(client, providerConfig).triggerImageBuild({
        ...buildConfig,
        onProviderSessionCreated,
      });

      const [params] = vi.mocked(client.createSandbox).mock.calls[0];
      expect(params).toMatchObject({
        type: "default",
        ttlSeconds: 2400,
        from: "open-inspect-abc123",
        monitoring: false,
        idempotencyKey: await boatIdempotencyKey(
          "test",
          buildConfig.buildId,
          "build-env-acme/repo"
        ),
      });
      expect(params.env).toMatchObject({
        IMAGE_BUILD_MODE: "true",
        OI_DEFERRED_START: "false",
        RESTORED_FROM_SNAPSHOT: "false",
        FROM_REPO_IMAGE: "false",
        SANDBOX_ID: "build-env-acme/repo",
        SANDBOX_VERSION: BOAT_SANDBOX_VERSION,
        OI_IMAGE_BUILD_EXECUTION_TIMEOUT_SECONDS: "1800",
        OI_REPO_IMAGE_BUILD_ID: buildConfig.buildId,
        OI_REPO_IMAGE_CALLBACK_URL: buildConfig.callbackUrl,
        OI_REPO_IMAGE_FAILURE_CALLBACK_URL: buildConfig.failureCallbackUrl,
        OI_REPO_IMAGE_CALLBACK_TOKEN: buildConfig.callbackToken,
        VCS_CLONE_TOKEN: "clone-token",
        FOO: "bar",
      });
      expect(JSON.parse(params.env.SESSION_CONFIG)).toEqual({
        branch: "main",
        repositories: [{ repo_owner: "acme", repo_name: "repo", branch: "main" }],
      });
      // The sandbox id does not exist at create time; it rides the launch instead.
      expect(params.env).not.toHaveProperty("OI_REPO_IMAGE_PROVIDER_SESSION_ID");
      expect(params.env).not.toHaveProperty("BOAT_ID");
      expect(params.env).not.toHaveProperty("SANDBOX_AUTH_TOKEN");
      expect(onProviderSessionCreated).toHaveBeenCalledWith("bx_abcdefgh");
      expect(order.indexOf("bind")).toBeLessThan(order.indexOf("ready"));
      expect(order.indexOf("ready")).toBeLessThan(order.indexOf("launch"));
      expect(client.startDetachedCommand).toHaveBeenCalledWith(
        "bx_abcdefgh",
        `OI_REPO_IMAGE_PROVIDER_SESSION_ID=bx_abcdefgh ${BOAT_LAUNCHER_PATH}`
      );
      expect(client.updateSandbox).toHaveBeenCalledWith("bx_abcdefgh", {
        name: expect.stringMatching(/^openinspect-test-build-env-acme\/repo-\d+$/),
      });
      expect(client.hostPort).not.toHaveBeenCalled();
      expect(client.deleteSandbox).not.toHaveBeenCalled();
    });

    it("deletes the build sandbox when it cannot be bound", async () => {
      const client = mockClient();
      const error = await createProvider(client, providerConfig)
        .triggerImageBuild({
          ...buildConfig,
          onProviderSessionCreated: vi.fn(async () => {
            throw new Error("bind failed");
          }),
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SandboxProviderError);
      expect((error as Error).message).toContain("bind failed");
      expect(client.deleteSandbox).toHaveBeenCalledWith("bx_abcdefgh");
      expect(client.startDetachedCommand).not.toHaveBeenCalled();
    });

    it("refuses to bind or launch a sandbox id outside the expected alphabet", async () => {
      const client = mockClient({
        createSandbox: vi.fn(async () => boatSandbox({ id: "bx_abc; rm -rf /", state: "ready" })),
      });
      const onProviderSessionCreated = vi.fn(async () => {});
      await expect(
        createProvider(client, providerConfig).triggerImageBuild({
          ...buildConfig,
          onProviderSessionCreated,
        })
      ).rejects.toThrow("expected alphabet");
      expect(onProviderSessionCreated).not.toHaveBeenCalled();
      expect(client.startDetachedCommand).not.toHaveBeenCalled();
      expect(client.deleteSandbox).toHaveBeenCalledWith("bx_abc; rm -rf /");
    });

    it("deletes the build sandbox when the launcher exits early", async () => {
      const client = mockClient({
        getCommandStatus: vi.fn(async () => ({
          status: "exited" as const,
          running: false,
          exitCode: 1,
          stdout: "",
          stderr: "toolchain missing",
        })),
      });
      await expect(
        createProvider(client, providerConfig).triggerImageBuild({
          ...buildConfig,
          onProviderSessionCreated: vi.fn(async () => {}),
        })
      ).rejects.toThrow("exited with code 1");
      expect(client.deleteSandbox).toHaveBeenCalledWith("bx_abcdefgh");
    });
  });

  describe("image finalization", () => {
    it("archives a live build sandbox and reports it stopped", async () => {
      const getSandbox = vi
        .fn()
        .mockResolvedValueOnce(boatSandbox({ state: "idle" }))
        .mockResolvedValue(
          boatSandbox({
            state: "archived",
            snapshotAvailable: true,
            stop: { id: "stop_1", status: "completed" },
          })
        );
      const client = mockClient({ getSandbox });
      await expect(
        createProvider(client, providerConfig).stopImageBuildSource("bx_abcdefgh", "build-1")
      ).resolves.toBe("stopped");
      expect(client.stopSandbox).toHaveBeenCalledWith("bx_abcdefgh", expect.any(AbortSignal));
    });

    it("does not stop a source that is already archived with a snapshot", async () => {
      const client = mockClient({
        getSandbox: vi.fn(async () => boatSandbox({ state: "archived", snapshotAvailable: true })),
      });
      await expect(
        createProvider(client, providerConfig).stopImageBuildSource("bx_abcdefgh", "build-1")
      ).resolves.toBe("stopped");
      expect(client.stopSandbox).not.toHaveBeenCalled();
    });

    it("reports a missing source and a slow archive distinctly", async () => {
      const missing = mockClient({
        getSandbox: vi.fn(async () => {
          throw new BoatNotFoundError("gone");
        }),
      });
      await expect(
        createProvider(missing, providerConfig).stopImageBuildSource("bx_abcdefgh", "build-1")
      ).resolves.toBe("missing");

      const slow = mockClient({
        getSandbox: vi.fn(async () =>
          boatSandbox({ state: "archiving", stop: { id: "stop_1", status: "pending" } })
        ),
      });
      await expect(
        createProvider(slow, providerConfig).stopImageBuildSource("bx_abcdefgh", "build-1")
      ).resolves.toBe("stopping");
    });

    it("fails a source that archived without a usable snapshot", async () => {
      const client = mockClient({
        getSandbox: vi.fn(async () =>
          boatSandbox({
            state: "archived",
            snapshotAvailable: false,
            stop: { id: "stop_1", status: "failing", error: "disk busy" },
          })
        ),
      });
      await expect(
        createProvider(client, providerConfig).stopImageBuildSource("bx_abcdefgh", "build-1")
      ).rejects.toThrow("disk busy");
    });

    it("saves, reads and deletes image snapshots through the client", async () => {
      const client = mockClient();
      const provider = createProvider(client, providerConfig);
      await expect(provider.saveImageSnapshot("bx_abcdefgh", "oi-img-x")).resolves.toMatchObject({
        status: "saving",
      });
      expect(client.saveNamedSnapshot).toHaveBeenCalledWith("bx_abcdefgh", "oi-img-x", undefined);
      await expect(provider.getImageSnapshot("oi-img-x")).resolves.toMatchObject({
        name: "oi-img-x",
      });
      vi.mocked(client.getNamedSnapshot).mockRejectedValueOnce(new BoatNotFoundError("gone"));
      await expect(provider.getImageSnapshot("oi-img-gone")).resolves.toBeNull();
      await provider.deleteProviderImage("oi-img-x");
      expect(client.deleteNamedSnapshot).toHaveBeenCalledWith("oi-img-x", undefined);
      vi.mocked(client.deleteNamedSnapshot).mockRejectedValueOnce(new BoatNotFoundError("gone"));
      await expect(provider.deleteProviderImage("oi-img-gone")).resolves.toBeUndefined();
      vi.mocked(client.deleteSandbox).mockRejectedValueOnce(new BoatNotFoundError("gone"));
      await expect(provider.deleteSandbox("bx_gone")).resolves.toBeUndefined();
    });

    it("keeps Boat's code on a refused save so the adapter can act on it", async () => {
      const client = mockClient({
        saveNamedSnapshot: vi.fn(async () => {
          throw new BoatApiError("credit", 402, "credit_required");
        }),
      });
      const error = await createProvider(client, providerConfig)
        .saveImageSnapshot("bx_abcdefgh", "oi-img-x")
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SandboxProviderError);
      expect((error as SandboxProviderError).errorType).toBe("permanent");
      expect(((error as SandboxProviderError).cause as BoatApiError).code).toBe("credit_required");
    });

    it("derives the image name for the deployment", async () => {
      const provider = createProvider(mockClient(), providerConfig);
      await expect(provider.imageSnapshotName("imgb-acme-repo-1757000000000-ab12")).resolves.toBe(
        await boatImageSnapshotName("test", "imgb-acme-repo-1757000000000-ab12")
      );
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

describe("resolveBoatMachineType", () => {
  it("returns the fallback when nothing is requested", () => {
    expect(resolveBoatMachineType(undefined, "default")).toBe("default");
    expect(resolveBoatMachineType({ cpuCores: null, memoryMib: null }, "small")).toBe("small");
  });

  it("picks the smallest size satisfying both dimensions", () => {
    expect(resolveBoatMachineType({ cpuCores: 1 }, "default")).toBe("small");
    expect(resolveBoatMachineType({ memoryMib: 5000 }, "small")).toBe("default");
    expect(resolveBoatMachineType({ cpuCores: 2, memoryMib: 16384 }, "small")).toBe("large");
    expect(resolveBoatMachineType({ cpuCores: 16 }, "small")).toBe("xlarge");
  });

  it("rejects a request no size can satisfy", () => {
    expect(() => resolveBoatMachineType({ cpuCores: 32 }, "default")).toThrow(SandboxProviderError);
    expect(() => resolveBoatMachineType({ memoryMib: 65536 }, "default")).toThrow(
      /exceed the largest Boat machine type/
    );
  });
});

describe("resolveBoatTtlSeconds", () => {
  it("defaults, rounds and clamps to Boat's bounds", () => {
    expect(resolveBoatTtlSeconds(undefined)).toBe(7200);
    expect(resolveBoatTtlSeconds(90.4)).toBe(90);
    expect(resolveBoatTtlSeconds(0)).toBe(1);
    expect(resolveBoatTtlSeconds(99_999_999)).toBe(2_592_000);
  });
});

describe("assertBoatEnvWithinLimits", () => {
  it("accepts an ordinary env", () => {
    expect(() => assertBoatEnvWithinLimits({ A: "1", _b2: "x".repeat(1000) })).not.toThrow();
  });

  it("names invalid keys without their values", () => {
    expect(() => assertBoatEnvWithinLimits({ "BAD-KEY": "secret-value" })).toThrow(
      /BAD-KEY(?!.*secret-value)/
    );
  });

  it("enforces the variable count and total size", () => {
    const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`K${i}`, "v"]));
    expect(() => assertBoatEnvWithinLimits(many)).toThrow(/101 variables/);
    expect(() => assertBoatEnvWithinLimits({ BIG: "x".repeat(64 * 1024) })).toThrow(/bytes/);
  });
});

describe("boatIdempotencyKey", () => {
  it("is deterministic per deployment, session and sandbox, and distinct across them", async () => {
    const key = await boatIdempotencyKey("prod", "sess-a", "sb-1");
    expect(key).toMatch(/^openinspect-[a-f0-9]{64}$/);
    expect(await boatIdempotencyKey("prod", "sess-a", "sb-1")).toBe(key);
    expect(await boatIdempotencyKey("staging", "sess-a", "sb-1")).not.toBe(key);
    expect(await boatIdempotencyKey("prod", "sess-a", "sb-2")).not.toBe(key);
    expect(await boatIdempotencyKey("prod", "sess-b", "sb-1")).not.toBe(key);
  });
});

describe("boatImageSnapshotName", () => {
  it("is a valid Boat name that leads with the build's scope and ends with a deployment digest", async () => {
    const name = await boatImageSnapshotName("prod", "imgb-acme-repo-1757000000000-ab12");
    expect(name).toMatch(BOAT_NAMED_SNAPSHOT_NAME_PATTERN);
    expect(name).toMatch(/^oi-img-acme-repo-1757000000000-ab12-[0-9a-f]{16}$/);
    expect(name).toBe(await boatImageSnapshotName("prod", "imgb-acme-repo-1757000000000-ab12"));
    expect(name).not.toBe(
      await boatImageSnapshotName("staging", "imgb-acme-repo-1757000000000-ab12")
    );
    expect(name).not.toBe(await boatImageSnapshotName("prod", "imgb-acme-repo-1757000000000-cd34"));
  });

  it("sanitizes nested owners and uppercase and stays within Boat's length limit", async () => {
    const name = await boatImageSnapshotName(
      "Prod_EU",
      "imgb-Group/Sub.group/a_very_long_repository_name-1757000000000-ab12"
    );
    expect(name).toMatch(BOAT_NAMED_SNAPSHOT_NAME_PATTERN);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/^oi-img-group-sub-group-a-very-long-[0-9a-f]{16}$/);
  });
});
