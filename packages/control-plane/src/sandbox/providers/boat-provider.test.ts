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
  boatCreated,
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
  type BoatCreateSandboxParams,
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
    it("deploys from the base snapshot named, private and routed in one request, and has Boat start the launcher", async () => {
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
        name: "openinspect-test-sandbox-logical",
        visibility: "private",
        hostedPorts: [{ port: 8080, public: true, title: "code-server" }],
      });
      // The create named the sandbox, made it private and routed its port.
      expect(client.updateSandbox).not.toHaveBeenCalled();
      expect(client.unshareSandbox).not.toHaveBeenCalled();
      expect(client.hostPort).not.toHaveBeenCalled();
      // The launch rides on the create too: Boat runs the setup script the
      // moment the machine is up, and it execs the launcher once the control
      // plane has released the launch, so no start command follows.
      expect(params.setupScript).toBe(BOAT_SETUP_SCRIPT);
      expect(client.writeFile).toHaveBeenCalledOnce();
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

    it("defaults noVNC to 6081, keeps tunnels protected and writes the tunnel env file into the workspace", async () => {
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
      // Every service and tunnel port rides the create, the services public
      // behind their own logins and the tunnels behind Boat's token.
      expect(vi.mocked(client.createSandbox).mock.calls[0][0].hostedPorts).toEqual([
        { port: 8080, public: true, title: "code-server" },
        { port: 7680, public: true, title: "terminal" },
        { port: 6081, public: true, title: "noVNC" },
        { port: 5173, public: false, title: "tunnel 5173" },
        { port: 3000, public: false, title: "tunnel 3000" },
      ]);
      expect(client.hostPort).not.toHaveBeenCalled();
      // Straight into the workspace: Boat holds a write to a starting sandbox
      // until it is ready, so the file lands on the disk the sandbox keeps.
      // Then the launch marker, and only then the first readiness read: the
      // runtime can start neither before the file nor after this side has
      // stopped looking.
      const writes = vi.mocked(client.writeFile).mock;
      expect(writes.calls.map(([, file]) => file)).toEqual([
        {
          path: BOAT_TUNNEL_ENV_FILE_PATH,
          content:
            "TUNNEL_SANDBOX_ID=sandbox-logical\n" +
            "TUNNEL_3000=https://sub-3000.on.boat.dev?_token=tok3000\n" +
            "TUNNEL_5173=https://sub-5173.on.boat.dev?_token=tok5173\n",
        },
        { path: BOAT_LAUNCH_MARKER_PATH, content: "released\n" },
      ]);
      expect(writes.invocationCallOrder[1]).toBeLessThan(
        vi.mocked(client.getSandbox).mock.invocationCallOrder[0]
      );
    });

    it("releases the launch only once the tunnel env file is written, however long Boat holds it", async () => {
      let finishTunnelWrite: () => void = () => undefined;
      const client = mockClient({
        writeFile: vi.fn(async (_id: string, file: { path: string }) => {
          if (file.path === BOAT_TUNNEL_ENV_FILE_PATH) {
            await new Promise<void>((resolve) => {
              finishTunnelWrite = resolve;
            });
          }
        }),
      });
      const creating = createProvider(client, providerConfig).createSandbox({
        ...baseCreateConfig,
        sandboxSettings: { tunnelPorts: [3000] },
      });
      await vi.waitFor(() =>
        expect(client.writeFile).toHaveBeenCalledWith(
          "bx_abcdefgh",
          expect.objectContaining({ path: BOAT_TUNNEL_ENV_FILE_PATH })
        )
      );
      // Boat holds the write until the sandbox is ready; the launch waits for it.
      expect(client.writeFile).not.toHaveBeenCalledWith(
        "bx_abcdefgh",
        expect.objectContaining({ path: BOAT_LAUNCH_MARKER_PATH })
      );
      finishTunnelWrite();
      await creating;
      expect(client.writeFile).toHaveBeenLastCalledWith("bx_abcdefgh", {
        path: BOAT_LAUNCH_MARKER_PATH,
        content: "released\n",
      });
    });

    it("asks for a private sandbox and makes one the create answered as shared private before use", async () => {
      const personal = mockClient();
      await createProvider(personal).createSandbox(baseCreateConfig);
      expect(vi.mocked(personal.createSandbox).mock.calls[0][0].visibility).toBe("private");
      expect(personal.unshareSandbox).not.toHaveBeenCalled();

      const shared = mockClient({
        createSandbox: vi.fn(async (params: BoatCreateSandboxParams) =>
          boatCreated(params, { visibility: "shared" })
        ),
      });
      const result = await createProvider(shared).createSandbox({
        ...baseCreateConfig,
        sandboxSettings: { tunnelPorts: [3000] },
      });
      expect(result.providerObjectId).toBe("bx_abcdefgh");
      expect(shared.unshareSandbox).toHaveBeenCalledWith("bx_abcdefgh");
      // Private before anything else reaches the sandbox, and so before the
      // launch is released: the runtime never runs in a shared sandbox.
      const unshareOrder = vi.mocked(shared.unshareSandbox).mock.invocationCallOrder[0];
      expect(unshareOrder).toBeLessThan(vi.mocked(shared.getSandbox).mock.invocationCallOrder[0]);
      expect(unshareOrder).toBeLessThan(vi.mocked(shared.writeFile).mock.invocationCallOrder[0]);
    });

    it("deletes a shared organization sandbox it cannot make private", async () => {
      const client = mockClient({
        createSandbox: vi.fn(async (params: BoatCreateSandboxParams) =>
          boatCreated(params, { visibility: "shared" })
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

    it("fails the create and deletes the sandbox when the tunnel env file cannot be written", async () => {
      const client = mockClient({
        writeFile: vi.fn(async () => {
          throw new BoatApiError("agent unavailable", 503);
        }),
      });
      const error = await createProvider(client, providerConfig)
        .createSandbox({ ...baseCreateConfig, sandboxSettings: { tunnelPorts: [3000] } })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SandboxProviderError);
      // The launch is never released, so no runtime starts without its URLs.
      expect(client.writeFile).not.toHaveBeenCalledWith(
        "bx_abcdefgh",
        expect.objectContaining({ path: BOAT_LAUNCH_MARKER_PATH })
      );
      expect(client.deleteSandbox).toHaveBeenCalledWith("bx_abcdefgh");
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

    it("hosts a port the create could not route with a call of its own", async () => {
      const client = mockClient({
        createSandbox: vi.fn(async (params: BoatCreateSandboxParams) => ({
          ...boatCreated(params),
          hostedPorts: [{ port: 8080, error: "host_failed", message: "route not ready" }],
        })),
      });
      const result = await createProvider(client, providerConfig).createSandbox(baseCreateConfig);
      expect(client.hostPort).toHaveBeenCalledOnce();
      expect(client.hostPort).toHaveBeenCalledWith("bx_abcdefgh", {
        port: 8080,
        public: true,
        title: "code-server",
      });
      expect(result.codeServerUrl).toBe("https://sub-8080.on.boat.dev");
    });

    it("keeps a failed access route from hiding the live sandbox", async () => {
      const client = mockClient({
        createSandbox: vi.fn(async (params: BoatCreateSandboxParams) => ({
          ...boatCreated(params),
          hostedPorts: [{ port: 8080, error: "host_failed" }],
        })),
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

    it("repeats a create whose response was lost with the same key and body", async () => {
      const createSandbox = vi
        .fn()
        .mockRejectedValueOnce(new BoatApiError("upstream", 503))
        .mockImplementationOnce(async (params: BoatCreateSandboxParams) => boatCreated(params));
      const client = mockClient({ createSandbox });
      const result = await createProvider(client, providerConfig).createSandbox(baseCreateConfig);
      expect(createSandbox).toHaveBeenCalledTimes(2);
      // Boat answers a repeat with the first sandbox only when both match.
      expect(createSandbox.mock.calls[1][0]).toEqual(createSandbox.mock.calls[0][0]);
      // The repeat answers the routes too, so no port is hosted again.
      expect(result.codeServerUrl).toBe("https://sub-8080.on.boat.dev");
      expect(client.hostPort).not.toHaveBeenCalled();
    });

    it("releases the launch only after a lost create is repeated and the tunnel env file is written", async () => {
      // The machine can come up, and Boat start the setup script, while this
      // side is still waiting out a lost create response; the script waits for
      // the marker, so start.sh can never run before its tunnel URLs.
      const createSandbox = vi
        .fn()
        .mockRejectedValueOnce(new BoatApiError("upstream", 503))
        .mockImplementationOnce(async (params: BoatCreateSandboxParams) => boatCreated(params));
      const client = mockClient({ createSandbox });
      await createProvider(client, providerConfig).createSandbox({
        ...baseCreateConfig,
        sandboxSettings: { tunnelPorts: [3000] },
      });

      expect(createSandbox).toHaveBeenCalledTimes(2);
      const writes = vi.mocked(client.writeFile).mock;
      expect(writes.calls.map(([, file]) => file.path)).toEqual([
        BOAT_TUNNEL_ENV_FILE_PATH,
        BOAT_LAUNCH_MARKER_PATH,
      ]);
      const repeatedCreate = createSandbox.mock.invocationCallOrder[1];
      expect(writes.invocationCallOrder[0]).toBeGreaterThan(repeatedCreate);
      expect(writes.invocationCallOrder[1]).toBeGreaterThan(writes.invocationCallOrder[0]);
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
      // A resume cannot route ports with its request, so each is hosted again.
      expect(client.hostPort).toHaveBeenCalledWith("bx_abcdefgh", {
        port: 3000,
        public: false,
        title: "tunnel 3000",
      });
      expect(client.writeFile).toHaveBeenCalledWith(
        "bx_abcdefgh",
        expect.objectContaining({ path: BOAT_TUNNEL_ENV_FILE_PATH })
      );
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
          throw new BoatNotFoundError("no saved snapshot", "snapshot_not_found");
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
          throw new BoatNotFoundError("no saved snapshot", "snapshot_not_found");
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
