/**
 * Unit tests for DaytonaSandboxProvider.
 *
 * Tests env-var assembly, label construction, code-server password derivation,
 * tunnel URL generation, and error handling for create/resume/stop flows.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { computeHmacHex } from "@open-inspect/shared/auth";
import { deriveVncPassword } from "../sandbox-env";
import { DaytonaSandboxProvider, type DaytonaProviderConfig } from "./daytona-provider";
import { PrebuiltImageActivationPendingError, SandboxProviderError } from "../provider";
import type { CreateSandboxConfig, ResumeConfig, StopConfig } from "../provider";
import {
  DaytonaNotFoundError,
  DaytonaApiError,
  DaytonaCancelledError,
  type DaytonaRestClient,
  type DaytonaSandboxResponse,
  type DaytonaSignedPreviewUrlResponse,
  type DaytonaCreateSandboxParams,
  type DaytonaToolboxTarget,
  type DaytonaRestConfig,
} from "../daytona-rest-client";

// ==================== Mock Factories ====================

const defaultRestConfig: DaytonaRestConfig = {
  apiUrl: "https://daytona.test/api",
  apiKey: "test-api-key",
  baseSnapshot: "base-snapshot-v1",
  autoStopIntervalMinutes: 120,
  autoArchiveIntervalMinutes: 10080,
};

function createMockClient(
  overrides: Partial<{
    createSandbox: (params: DaytonaCreateSandboxParams) => Promise<DaytonaSandboxResponse>;
    getSandbox: (id: string) => Promise<DaytonaSandboxResponse>;
    startSandbox: (id: string) => Promise<void>;
    stopSandbox: (id: string) => Promise<void>;
    deleteSandbox: (id: string) => Promise<void>;
    recoverSandbox: (id: string) => Promise<void>;
    getSignedPreviewUrl: (
      id: string,
      port: number,
      expiry: number
    ) => Promise<DaytonaSignedPreviewUrlResponse>;
  }> = {},
  configOverrides: Partial<DaytonaRestConfig> = {}
): DaytonaRestClient {
  const config = { ...defaultRestConfig, ...configOverrides };
  return {
    config,
    requireBaseSnapshot: vi.fn(() => {
      if (!config.baseSnapshot) throw new Error("DAYTONA_BASE_SNAPSHOT is required");
      return config.baseSnapshot;
    }),
    createSandbox: vi.fn(
      async (): Promise<DaytonaSandboxResponse> => ({
        id: "daytona-sandbox-id",
        state: "started",
      })
    ),
    getSandbox: vi.fn(
      async (): Promise<DaytonaSandboxResponse> => ({
        id: "daytona-sandbox-id",
        state: "started",
      })
    ),
    startSandbox: vi.fn(async () => {}),
    stopSandbox: vi.fn(async () => {}),
    deleteSandbox: vi.fn(async () => {}),
    recoverSandbox: vi.fn(async () => {}),
    getSignedPreviewUrl: vi.fn(
      async (): Promise<DaytonaSignedPreviewUrlResponse> => ({
        url: "https://preview.test/signed",
      })
    ),
    ...overrides,
  } as unknown as DaytonaRestClient;
}

const defaultProviderConfig: DaytonaProviderConfig = {
  scmProvider: "github",
  sandboxAccessPasswordSecret: "test-secret-key",
};

const baseCreateConfig: CreateSandboxConfig = {
  sessionId: "session-123",
  sandboxId: "sandbox-456",
  repoOwner: "testowner",
  repoName: "testrepo",
  controlPlaneUrl: "https://control-plane.test",
  sandboxAuthToken: "auth-token-abc",
  harness: "opencode" as const,
  provider: "anthropic",
  model: "anthropic/claude-sonnet-4-5",
};

const baseResumeConfig: ResumeConfig = {
  providerObjectId: "daytona-sandbox-id",
  sessionId: "session-123",
  sandboxId: "sandbox-456",
};

const baseStopConfig: StopConfig = {
  providerObjectId: "daytona-sandbox-id",
  sessionId: "session-123",
  reason: "inactivity_timeout",
};

// ==================== Tests ====================

describe("DaytonaSandboxProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("capabilities", () => {
    it("reports correct capabilities", () => {
      const provider = new DaytonaSandboxProvider(createMockClient(), defaultProviderConfig);
      expect(provider.name).toBe("daytona");
      expect(provider.capabilities).toEqual({
        supportsSandboxTimeout: false,
        supportsSnapshots: false,
        supportsRestore: false,
        supportsPersistentResume: true,
        supportsExplicitStop: true,
      });
    });
  });

  describe("createSandbox", () => {
    it("happy path: creates sandbox with env vars, labels, and tunnel URLs", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      const result = await provider.createSandbox(baseCreateConfig);

      expect(result.sandboxId).toBe("sandbox-456");
      expect(result.providerObjectId).toBe("daytona-sandbox-id");
      expect(result.createdAt).toBeGreaterThan(0);

      // Verify create was called with correct params
      const createCall = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.name).toBe("sandbox-456");
      expect(createCall.snapshot).toBe("base-snapshot-v1");
      expect(createCall.autoStopInterval).toBe(120);
      expect(createCall.autoArchiveInterval).toBe(10080);
      expect(createCall.public).toBe(false);
    });

    it("assembles env vars correctly for GitHub, without embedding any token", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox(baseCreateConfig);

      const createCall = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const envVars = createCall.env;

      expect(envVars.PYTHONUNBUFFERED).toBe("1");
      expect(envVars.SANDBOX_ID).toBe("sandbox-456");
      expect(envVars.CONTROL_PLANE_URL).toBe("https://control-plane.test");
      expect(envVars.SANDBOX_AUTH_TOKEN).toBe("auth-token-abc");
      expect(envVars.REPO_OWNER).toBe("testowner");
      expect(envVars.REPO_NAME).toBe("testrepo");
      expect(envVars.VCS_HOST).toBe("github.com");
      expect(envVars.VCS_CLONE_USERNAME).toBe("x-access-token");
      // Git authenticates via the sandbox credential helper, not env vars.
      expect(envVars.VCS_CLONE_TOKEN).toBeUndefined();
      expect(envVars.GITHUB_APP_TOKEN).toBeUndefined();
      expect(envVars.GITHUB_TOKEN).toBeUndefined();

      const sessionConfig = JSON.parse(envVars.SESSION_CONFIG);
      expect(sessionConfig).toEqual({
        session_id: "session-123",
        harness: "opencode",
        repo_owner: "testowner",
        repo_name: "testrepo",
        provider: "anthropic",
        model: "anthropic/claude-sonnet-4-5",
      });
    });

    it("assembles env vars correctly for GitLab", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(client, {
        scmProvider: "gitlab",
        gitlabAccessToken: "glpat-test-token",
        sandboxAccessPasswordSecret: "secret",
      });

      await provider.createSandbox(baseCreateConfig);

      const envVars = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0].env;
      expect(envVars.VCS_HOST).toBe("gitlab.com");
      expect(envVars.VCS_CLONE_USERNAME).toBe("oauth2");
      expect(envVars.VCS_CLONE_TOKEN).toBeUndefined();
    });

    it("maps bitbucket to the Bitbucket clone identity", async () => {
      // Daytona historically collapsed bitbucket to the GitHub identity (a
      // pre-Bitbucket-support drift that made bitbucket clones impossible);
      // it now resolves the real Bitbucket identity like every provider.
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(client, {
        scmProvider: "bitbucket",
        sandboxAccessPasswordSecret: "secret",
      });

      await provider.createSandbox(baseCreateConfig);

      const envVars = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0].env;
      expect(envVars.VCS_HOST).toBe("bitbucket.org");
      expect(envVars.VCS_CLONE_USERNAME).toBe("x-token-auth");
    });

    it("includes branch in SESSION_CONFIG when provided", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox({ ...baseCreateConfig, branch: "feature/test" });

      const envVars = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0].env;
      const sessionConfig = JSON.parse(envVars.SESSION_CONFIG);
      expect(sessionConfig.branch).toBe("feature/test");
    });

    it("includes mcp_servers in SESSION_CONFIG when provided", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox({
        ...baseCreateConfig,
        mcpServers: [{ id: "mcp-1", name: "Tool", type: "local", enabled: true }],
      });

      const envVars = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0].env;
      const sessionConfig = JSON.parse(envVars.SESSION_CONFIG);
      expect(sessionConfig.mcp_servers).toEqual([
        { id: "mcp-1", name: "Tool", type: "local", enabled: true },
      ]);
    });

    it("includes user env vars (repo secrets) with system vars taking precedence", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox({
        ...baseCreateConfig,
        userEnvVars: { MY_SECRET: "value123", SANDBOX_ID: "should-be-overridden" },
      });

      const envVars = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0].env;
      expect(envVars.MY_SECRET).toBe("value123");
      // System var overrides user-provided duplicate
      expect(envVars.SANDBOX_ID).toBe("sandbox-456");
    });

    it("builds labels correctly", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox(baseCreateConfig);

      const createCall = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const labels = createCall.labels;
      expect(labels).toEqual({
        openinspect_framework: "open-inspect",
        openinspect_session_id: "session-123",
        openinspect_repo: "testowner/testrepo",
        openinspect_expected_sandbox_id: "sandbox-456",
      });
    });

    it("omits repo label for no-repository sandboxes", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox({
        ...baseCreateConfig,
        repoOwner: null,
        repoName: null,
      });

      const createCall = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.env).toMatchObject({
        REPO_OWNER: "",
        REPO_NAME: "",
      });
      const labels = createCall.labels;
      expect(labels).toEqual({
        openinspect_framework: "open-inspect",
        openinspect_session_id: "session-123",
        openinspect_expected_sandbox_id: "sandbox-456",
      });
    });

    it("passes target to create params when set", async () => {
      const client = createMockClient({}, { target: "us-east-1" });
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox(baseCreateConfig);

      const createCall = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.target).toBe("us-east-1");
    });

    it("omits target from create params when not set", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox(baseCreateConfig);

      const createCall = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.target).toBeUndefined();
    });

    it("never embeds a token in the sandbox environment", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox(baseCreateConfig);

      const envVars = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0].env;
      expect(envVars.VCS_CLONE_TOKEN).toBeUndefined();
      expect(envVars.GITHUB_APP_TOKEN).toBeUndefined();
      expect(envVars.GITHUB_TOKEN).toBeUndefined();
    });

    it("sets AGENT_SLACK_NOTIFY_ENABLED=true when agentSlackNotifyEnabled is on", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox({ ...baseCreateConfig, agentSlackNotifyEnabled: true });

      const envVars = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0].env;
      expect(envVars.AGENT_SLACK_NOTIFY_ENABLED).toBe("true");
    });

    it("omits AGENT_SLACK_NOTIFY_ENABLED when disabled (absent key, not 'false')", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox(baseCreateConfig);

      const envVars = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0].env;
      expect(envVars.AGENT_SLACK_NOTIFY_ENABLED).toBeUndefined();
    });

    it("omits AGENT_SLACK_NOTIFY_ENABLED when explicitly false", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox({ ...baseCreateConfig, agentSlackNotifyEnabled: false });

      const envVars = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0].env;
      expect(envVars.AGENT_SLACK_NOTIFY_ENABLED).toBeUndefined();
    });

    it("classifies DaytonaApiError as SandboxProviderError", async () => {
      const client = createMockClient({
        createSandbox: async () => {
          throw new DaytonaApiError("quota exceeded", 422);
        },
      });
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      try {
        await provider.createSandbox(baseCreateConfig);
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("permanent");
      }
    });

    it("classifies 502 as transient error", async () => {
      const client = createMockClient({
        createSandbox: async () => {
          throw new DaytonaApiError("bad gateway", 502);
        },
      });
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      try {
        await provider.createSandbox(baseCreateConfig);
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("transient");
      }
    });
  });

  describe("code-server password derivation", () => {
    it("derives deterministic password via HMAC", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox({
        ...baseCreateConfig,
        codeServerEnabled: true,
      });

      const envVars = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0].env;
      const expectedDigest = await computeHmacHex("code-server:sandbox-456", "test-secret-key");
      expect(envVars.CODE_SERVER_PASSWORD).toBe(expectedDigest.slice(0, 32));
      expect(envVars.CODE_SERVER_PASSWORD).toHaveLength(32);
    });

    it("does not set CODE_SERVER_PASSWORD when disabled", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      await provider.createSandbox(baseCreateConfig);

      const envVars = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0].env;
      expect(envVars.CODE_SERVER_PASSWORD).toBeUndefined();
    });

    it("injects and returns VNC access without including its port in generic tunnels", async () => {
      const client = createMockClient({
        getSignedPreviewUrl: async (_id, port) => ({ url: `https://preview.test/${port}` }),
      });
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      const result = await provider.createSandbox({
        ...baseCreateConfig,
        vncEnabled: true,
        sandboxSettings: { vncPort: 6099, tunnelPorts: [6099, 3000] },
      });
      const envVars = vi.mocked(client.createSandbox).mock.calls[0][0].env;
      const expected = await deriveVncPassword("sandbox-456", "test-secret-key");

      expect(envVars).toMatchObject({ VNC_PASSWORD: expected, NOVNC_PORT: "6099" });
      expect(result).toMatchObject({
        vncAccess: { url: "https://preview.test/6099", password: expected },
        tunnelUrls: { "3000": "https://preview.test/3000" },
      });
    });
  });

  describe("resumeSandbox", () => {
    it("happy path: resumes a stopped sandbox", async () => {
      const client = createMockClient({
        getSandbox: async () => ({ id: "daytona-sandbox-id", state: "stopped" }),
      });
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      const result = await provider.resumeSandbox(baseResumeConfig);

      expect(result.success).toBe(true);
      expect(result.providerObjectId).toBe("daytona-sandbox-id");
      expect(client.startSandbox).toHaveBeenCalledWith("daytona-sandbox-id");
    });

    it("returns shouldSpawnFresh when sandbox not found", async () => {
      const client = createMockClient({
        getSandbox: async () => {
          throw new DaytonaNotFoundError("not found");
        },
      });
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      const result = await provider.resumeSandbox(baseResumeConfig);

      expect(result.success).toBe(false);
      expect(result.shouldSpawnFresh).toBe(true);
    });

    it("recovers sandbox in error state when recoverable", async () => {
      const client = createMockClient({
        getSandbox: async () => ({
          id: "daytona-sandbox-id",
          state: "error",
          recoverable: true,
        }),
      });
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      await provider.resumeSandbox(baseResumeConfig);

      expect(client.recoverSandbox).toHaveBeenCalledWith("daytona-sandbox-id");
      expect(client.startSandbox).not.toHaveBeenCalled();
    });

    it("recovers sandbox in build_failed state when recoverable", async () => {
      const client = createMockClient({
        getSandbox: async () => ({
          id: "daytona-sandbox-id",
          state: "build_failed",
          recoverable: true,
        }),
      });
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      await provider.resumeSandbox(baseResumeConfig);

      expect(client.recoverSandbox).toHaveBeenCalledWith("daytona-sandbox-id");
    });

    it("starts sandbox in error state when not recoverable", async () => {
      const client = createMockClient({
        getSandbox: async () => ({
          id: "daytona-sandbox-id",
          state: "error",
          recoverable: false,
        }),
      });
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      await provider.resumeSandbox(baseResumeConfig);

      expect(client.startSandbox).toHaveBeenCalledWith("daytona-sandbox-id");
      expect(client.recoverSandbox).not.toHaveBeenCalled();
    });

    it("does not start or recover when already started", async () => {
      const client = createMockClient({
        getSandbox: async () => ({ id: "daytona-sandbox-id", state: "started" }),
      });
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      const result = await provider.resumeSandbox(baseResumeConfig);

      expect(result.success).toBe(true);
      expect(client.startSandbox).not.toHaveBeenCalled();
      expect(client.recoverSandbox).not.toHaveBeenCalled();
    });

    it("returns VNC access after resume", async () => {
      const client = createMockClient({
        getSignedPreviewUrl: async (_id, port) => ({ url: `https://preview.test/${port}` }),
      });
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      const result = await provider.resumeSandbox({ ...baseResumeConfig, vncEnabled: true });

      expect(result.vncAccess?.url).toBe("https://preview.test/6080");
      expect(result.vncAccess?.password).toMatch(/^[A-Za-z0-9]{8}$/);
    });

    it("tunnel URL failure does not fail the resume", async () => {
      const client = createMockClient({
        getSandbox: async () => ({ id: "daytona-sandbox-id", state: "stopped" }),
        getSignedPreviewUrl: async () => {
          throw new Error("tunnel service down");
        },
      });
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      const result = await provider.resumeSandbox({
        ...baseResumeConfig,
        codeServerEnabled: true,
      });

      expect(result.success).toBe(true);
      expect(result.codeServerUrl).toBeUndefined();
    });
  });

  describe("stopSandbox", () => {
    it("happy path: stops sandbox", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      const result = await provider.stopSandbox(baseStopConfig);

      expect(result.success).toBe(true);
      expect(client.stopSandbox).toHaveBeenCalledWith("daytona-sandbox-id");
    });

    it("deletes sandbox on replacement", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);
      const signal = AbortSignal.timeout(1_000);

      const result = await provider.stopSandbox({ ...baseStopConfig, reason: "respawn", signal });

      expect(result.success).toBe(true);
      expect(client.deleteSandbox).toHaveBeenCalledWith("daytona-sandbox-id", signal);
      expect(client.stopSandbox).not.toHaveBeenCalled();
    });

    it("returns success when sandbox not found (already gone)", async () => {
      const client = createMockClient({
        stopSandbox: async () => {
          throw new DaytonaNotFoundError("not found");
        },
      });
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      const result = await provider.stopSandbox(baseStopConfig);

      expect(result.success).toBe(true);
    });

    it("classifies non-404 errors as SandboxProviderError", async () => {
      const client = createMockClient({
        stopSandbox: async () => {
          throw new DaytonaApiError("service unavailable", 503);
        },
      });
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      try {
        await provider.stopSandbox(baseStopConfig);
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(SandboxProviderError);
        expect((e as SandboxProviderError).errorType).toBe("transient");
      }
    });
  });
});

// ==================== Image-build lifecycle ====================

const BUILD_ID = "imgb-acme-web-1757000000000-ab12";

/** A client mock with the toolbox and snapshot surface a build exercises. */
function createBuildClient(overrides: Record<string, unknown> = {}) {
  const config = { ...defaultRestConfig };
  return {
    config,
    requireBaseSnapshot: vi.fn(() => config.baseSnapshot as string),
    createSandbox: vi.fn(
      async (_params: DaytonaCreateSandboxParams): Promise<DaytonaSandboxResponse> => ({
        id: "daytona-build-1",
        state: "creating",
      })
    ),
    getSandbox: vi.fn(async (_idOrName: string) => ({
      id: "daytona-build-1",
      state: "started",
      labels: {
        openinspect_framework: "open-inspect",
        openinspect_kind: "environment-image-build",
        openinspect_build_id: BUILD_ID,
      },
    })),
    stopSandbox: vi.fn(async () => undefined),
    deleteSandbox: vi.fn(async () => undefined),
    resolveToolboxBaseUrl: vi.fn(async () => "https://runner.test/toolbox"),
    createProcessSession: vi.fn(async () => undefined),
    executeSessionCommand: vi.fn(
      async (_target: DaytonaToolboxTarget, _sessionId: string, _command: string) => ({
        cmdId: "cmd-1",
      })
    ),
    sendSessionCommandInput: vi.fn(
      async (
        _target: DaytonaToolboxTarget,
        _sessionId: string,
        _commandId: string,
        _input: string
      ) => undefined
    ),
    getSessionCommand: vi.fn(async () => ({ id: "cmd-1", exitCode: null })),
    createSandboxSnapshot: vi.fn(async () => ({ id: "daytona-build-1", state: "snapshotting" })),
    getSnapshot: vi.fn(async () => ({
      id: "snapshot-1",
      name: "oi-image-abc",
      state: "active",
      sourceSandboxId: "daytona-build-1",
    })),
    activateSnapshot: vi.fn(async () => ({
      id: "snapshot-1",
      name: "oi-image-abc",
      state: "active",
    })),
    deleteSnapshot: vi.fn(async () => undefined),
    ...overrides,
  };
}

function buildTriggerConfig(overrides: Record<string, unknown> = {}) {
  return {
    buildId: BUILD_ID,
    scopeKind: "repo" as const,
    scopeId: "acme/web",
    repositories: [
      { repoOwner: "acme", repoName: "web", baseBranch: "main" },
      { repoOwner: "acme", repoName: "api", baseBranch: "develop" },
    ],
    callbackUrl: "https://worker.test/image-builds/build-complete",
    failureCallbackUrl: "https://worker.test/image-builds/build-failed",
    callbackToken: "b".repeat(64),
    userEnvVars: { SCOPE_SECRET: "scope-value" },
    cloneToken: "clone-token-1",
    buildExecutionTimeoutSeconds: 1800,
    providerSessionTimeoutSeconds: 2400,
    onProviderSessionCreated: vi.fn(async () => undefined),
    correlation: { request_id: "request-1", trace_id: "trace-1" },
    ...overrides,
  };
}

function buildProvider(client: ReturnType<typeof createBuildClient>) {
  return new DaytonaSandboxProvider(client as unknown as DaytonaRestClient, defaultProviderConfig);
}

/** Longer than any single lifecycle budget the provider waits out. */
const PROVIDER_TEST_CLOCK_MS = 180_000;
const TEST_CLOCK_SLICES = 40;

/**
 * Drive a provider call that paces itself to completion. Every lifecycle flow
 * polls, so the test clock — not wall time — is what these assertions run on.
 *
 * The clock is advanced in slices until the call settles, because a flow
 * arms its next wait only after work that does not resolve on the microtask
 * queue (the digest behind a resource name, for one): a single advance can
 * finish before the timer it was meant to fire exists.
 */
async function complete<T>(operation: Promise<T>): Promise<T> {
  let done = false;
  const settled = operation.then(
    (value) => {
      done = true;
      return { ok: true as const, value };
    },
    (error: unknown) => {
      done = true;
      return { ok: false as const, error };
    }
  );
  for (let slice = 0; slice < TEST_CLOCK_SLICES && !done; slice += 1) {
    await vi.advanceTimersByTimeAsync(PROVIDER_TEST_CLOCK_MS / TEST_CLOCK_SLICES);
  }
  const result = await settled;
  if (!result.ok) throw result.error;
  return result.value;
}

describe("DaytonaSandboxProvider image builds", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("creates a dormant source carrying nothing secret, then binds before launching", async () => {
    const client = createBuildClient();
    const config = buildTriggerConfig();
    const order: string[] = [];
    config.onProviderSessionCreated.mockImplementation(async () => {
      order.push("bind");
    });
    client.executeSessionCommand.mockImplementation(async () => {
      order.push("exec");
      return { cmdId: "cmd-1" };
    });

    await complete(buildProvider(client).triggerImageBuild(config));

    const params = client.createSandbox.mock.calls[0][0];
    // The only two values a container capture may inherit.
    expect(params.env).toEqual({ OI_DEFERRED_START: "true", PYTHONUNBUFFERED: "1" });
    expect(JSON.stringify(params)).not.toContain(config.callbackToken);
    expect(JSON.stringify(params)).not.toContain("clone-token-1");
    expect(JSON.stringify(params)).not.toContain("scope-value");
    expect(params.name).toMatch(/^oi-source-[0-9a-f]{24}$/);
    expect(params.labels).toMatchObject({
      openinspect_kind: "environment-image-build",
      openinspect_build_id: BUILD_ID,
      openinspect_expires_at: expect.any(String),
    });
    // No auto-stop during a long quiet setup hook, the longest archive
    // interval, and a hard TTL that outlives the execution budget.
    expect(params.autoStopInterval).toBe(0);
    expect(params.autoArchiveInterval).toBe(0);
    expect(params.ttlMinutes).toBe(40);
    // Nothing asks Daytona to delete the source on stop: finalization needs
    // it stopped and still there.
    expect(Object.keys(params)).not.toContain("autoDeleteInterval");

    expect(order).toEqual(["bind", "exec"]);
    expect(config.onProviderSessionCreated).toHaveBeenCalledWith("daytona-build-1");
  });

  it("launches once, with the whole context on stdin and none of it on the command line", async () => {
    const client = createBuildClient();
    const config = buildTriggerConfig();

    await complete(buildProvider(client).triggerImageBuild(config));

    expect(client.executeSessionCommand).toHaveBeenCalledTimes(1);
    expect(client.sendSessionCommandInput).toHaveBeenCalledTimes(1);
    const command = client.executeSessionCommand.mock.calls[0][2];
    expect(command).toBe("python -m sandbox_runtime.entrypoint --image-build-context-stdin-v1");
    expect(command).not.toContain(config.callbackToken);

    const input = client.sendSessionCommandInput.mock.calls[0][3];
    expect(input.endsWith("\n")).toBe(true);
    expect(JSON.parse(input)).toEqual({
      version: 1,
      build_id: BUILD_ID,
      provider_session_id: "daytona-build-1",
      sandbox_id: "build-env-acme/web",
      callback_url: config.callbackUrl,
      failure_callback_url: config.failureCallbackUrl,
      callback_token: config.callbackToken,
      execution_timeout_seconds: 1800,
      repositories: [
        { repo_owner: "acme", repo_name: "web", branch: "main" },
        { repo_owner: "acme", repo_name: "api", branch: "develop" },
      ],
      clone: { host: "github.com", username: "x-access-token", token: "clone-token-1" },
      env: { SCOPE_SECRET: "scope-value" },
    });
  });

  it("sends clone identity without a token when none could be brokered", async () => {
    const client = createBuildClient();

    await complete(
      buildProvider(client).triggerImageBuild(buildTriggerConfig({ cloneToken: undefined }))
    );

    expect(JSON.parse(client.sendSessionCommandInput.mock.calls[0][3]).clone).toEqual({
      host: "github.com",
      username: "x-access-token",
    });
  });

  it.each([
    ["the bind", "onProviderSessionCreated"],
    ["the launch", "executeSessionCommand"],
    ["the context write", "sendSessionCommandInput"],
  ])("deletes the source when %s fails", async (_name, failing) => {
    const client = createBuildClient();
    const config = buildTriggerConfig();
    const failure = new Error("provider refused");
    if (failing === "onProviderSessionCreated") {
      config.onProviderSessionCreated.mockRejectedValue(failure);
    } else {
      (client as unknown as Record<string, ReturnType<typeof vi.fn>>)[failing].mockRejectedValue(
        failure
      );
    }

    await expect(complete(buildProvider(client).triggerImageBuild(config))).rejects.toThrow();

    expect(client.deleteSandbox).toHaveBeenCalledWith("daytona-build-1", expect.any(AbortSignal));
  });

  it("fails the trigger when the launcher has already refused its context", async () => {
    const client = createBuildClient({
      getSessionCommand: vi.fn(async () => ({ id: "cmd-1", exitCode: 1 })),
    });

    await expect(
      complete(buildProvider(client).triggerImageBuild(buildTriggerConfig()))
    ).rejects.toThrow(/exited 1/);
    expect(client.deleteSandbox).toHaveBeenCalled();
  });

  it("refuses to bind a provider id it would not address safely", async () => {
    const client = createBuildClient({
      createSandbox: vi.fn(async () => ({ id: "sandbox id/../etc", state: "creating" })),
    });
    const config = buildTriggerConfig();

    await expect(complete(buildProvider(client).triggerImageBuild(config))).rejects.toThrow(
      /Unsafe/
    );
    expect(config.onProviderSessionCreated).not.toHaveBeenCalled();
  });

  it("stops a started source and reports one that has not settled", async () => {
    const stopped = createBuildClient({
      getSandbox: vi
        .fn()
        .mockResolvedValueOnce({ id: "daytona-build-1", state: "started", labels: {} })
        .mockResolvedValue({ id: "daytona-build-1", state: "stopped", labels: {} }),
    });

    await expect(
      complete(buildProvider(stopped).stopBuildSandboxForCapture("daytona-build-1"))
    ).resolves.toBe("stopped");
    expect(stopped.stopSandbox).toHaveBeenCalledWith("daytona-build-1", undefined);

    const alreadyStopped = createBuildClient({
      getSandbox: vi.fn(async () => ({ id: "daytona-build-1", state: "stopped", labels: {} })),
    });
    await expect(
      complete(buildProvider(alreadyStopped).stopBuildSandboxForCapture("daytona-build-1"))
    ).resolves.toBe("stopped");
    expect(alreadyStopped.stopSandbox).not.toHaveBeenCalled();
  });

  it("refuses to capture a source that reached a terminal state", async () => {
    const client = createBuildClient({
      getSandbox: vi.fn(async () => ({ id: "daytona-build-1", state: "error", labels: {} })),
    });

    await expect(
      complete(buildProvider(client).stopBuildSandboxForCapture("daytona-build-1"))
    ).rejects.toThrow(/can no longer be captured/);
  });

  it("treats a capture name that already exists as accepted", async () => {
    const client = createBuildClient({
      createSandboxSnapshot: vi.fn(async () => {
        throw new DaytonaApiError("snapshot name already exists", 409);
      }),
    });

    await expect(
      complete(buildProvider(client).captureBuildSnapshot("daytona-build-1", "oi-image-abc"))
    ).resolves.toBeUndefined();
  });

  it("verifies build ownership before deleting a source", async () => {
    const client = createBuildClient({
      getSandbox: vi.fn(async () => ({
        id: "daytona-build-1",
        state: "started",
        labels: { openinspect_kind: "environment-image-build", openinspect_build_id: "other" },
      })),
    });

    await expect(
      complete(buildProvider(client).deleteBuildSandbox("daytona-build-1", BUILD_ID))
    ).rejects.toThrow(/ownership labels/);
    expect(client.deleteSandbox).not.toHaveBeenCalled();
  });

  it("observes a source deletion to completion", async () => {
    const client = createBuildClient({
      getSandbox: vi
        .fn()
        .mockResolvedValueOnce({
          id: "daytona-build-1",
          state: "started",
          labels: {
            openinspect_framework: "open-inspect",
            openinspect_kind: "environment-image-build",
            openinspect_build_id: BUILD_ID,
          },
        })
        .mockResolvedValue({ id: "daytona-build-1", state: "destroyed" }),
    });

    await expect(
      complete(buildProvider(client).deleteBuildSandbox("daytona-build-1", BUILD_ID))
    ).resolves.toBeUndefined();
    expect(client.deleteSandbox).toHaveBeenCalledWith("daytona-build-1", undefined);
  });

  it("keeps the cleanup obligation while a source is still being destroyed", async () => {
    {
      const client = createBuildClient({
        getSandbox: vi.fn(async () => ({
          id: "daytona-build-1",
          state: "destroying",
          labels: {
            openinspect_framework: "open-inspect",
            openinspect_kind: "environment-image-build",
            openinspect_build_id: BUILD_ID,
          },
        })),
      });

      const deleting = buildProvider(client)
        .deleteBuildSandbox("daytona-build-1", BUILD_ID)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(await deleting).toMatchObject({
        name: "SandboxProviderError",
        errorType: "transient",
      });
      // Already destroying: issuing another delete would be pointless noise.
      expect(client.deleteSandbox).not.toHaveBeenCalled();
    }
  });

  it("finds a source by its reserved name only when the labels agree", async () => {
    const mine = createBuildClient();
    await expect(
      complete(buildProvider(mine).findBuildSandboxByName(BUILD_ID))
    ).resolves.toMatchObject({ id: "daytona-build-1" });
    expect(mine.getSandbox.mock.calls[0][0]).toMatch(/^oi-source-[0-9a-f]{24}$/);

    const theirs = createBuildClient({
      getSandbox: vi.fn(async () => ({
        id: "daytona-build-1",
        state: "started",
        labels: { openinspect_build_id: "another-build" },
      })),
    });
    await expect(
      complete(buildProvider(theirs).findBuildSandboxByName(BUILD_ID))
    ).resolves.toBeNull();

    const absent = createBuildClient({
      getSandbox: vi.fn(async () => {
        throw new DaytonaNotFoundError("gone");
      }),
    });
    await expect(
      complete(buildProvider(absent).findBuildSandboxByName(BUILD_ID))
    ).resolves.toBeNull();
  });

  it("never deletes the configured base snapshot", async () => {
    const byName = createBuildClient();

    await expect(
      complete(buildProvider(byName).deleteProviderImage("base-snapshot-v1"))
    ).rejects.toThrow(/base snapshot/);
    expect(byName.deleteSnapshot).not.toHaveBeenCalled();

    const byId = createBuildClient({
      getSnapshot: vi.fn(async () => ({
        id: "snapshot-1",
        name: "base-snapshot-v1",
        state: "active",
      })),
    });
    await expect(complete(buildProvider(byId).deleteProviderImage("snapshot-1"))).rejects.toThrow(
      /base snapshot/
    );
    expect(byId.deleteSnapshot).not.toHaveBeenCalled();
  });

  it("confirms a snapshot is gone before reporting it deleted", async () => {
    const client = createBuildClient({
      getSnapshot: vi
        .fn()
        .mockResolvedValueOnce({
          id: "snapshot-1",
          name: "oi-image-abc",
          state: "active",
          sourceSandboxId: "daytona-build-1",
        })
        .mockRejectedValue(new DaytonaNotFoundError("gone")),
    });

    await expect(
      complete(buildProvider(client).deleteProviderImage("snapshot-1"))
    ).resolves.toBeUndefined();
    expect(client.deleteSnapshot).toHaveBeenCalledWith("snapshot-1", undefined);
  });

  it("keeps the obligation for a snapshot that is still being removed", async () => {
    {
      const client = createBuildClient({
        getSnapshot: vi.fn(async () => ({
          id: "snapshot-1",
          name: "oi-image-abc",
          state: "removing",
        })),
      });

      const deleting = buildProvider(client)
        .deleteProviderImage("snapshot-1")
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(await deleting).toMatchObject({ errorType: "transient" });
      expect(client.deleteSnapshot).not.toHaveBeenCalled();
    }
  });
});

/** Mirrors PREBUILT_ACTIVATION_TIMEOUT_MS in daytona-provider.ts. */
const ACTIVATION_BUDGET_MS = 45_000;
/** Mirrors LIFECYCLE_POLL_INTERVAL_MS in daytona-provider.ts. */
const ACTIVATION_POLL_INTERVAL_MS = 2_000;
/** Fine enough that an assertion on elapsed virtual time measures the budget. */
const CLOCK_STEP_MS = 250;

/**
 * Run `operation` on the fake clock and hand back whatever it settles with.
 *
 * The clock is advanced in fine slices so the elapsed virtual time an
 * assertion reads is the flow's own budget rather than the granularity of
 * the advance, and so a flow that arms its next wait only after a resolved
 * request still gets its timer fired.
 */
async function settleOnFakeClock(operation: Promise<unknown>, clockBudgetMs: number) {
  let done = false;
  let outcome: unknown;
  const tracked = operation.then(
    (value) => {
      done = true;
      outcome = value;
    },
    (error: unknown) => {
      done = true;
      outcome = error;
    }
  );
  for (let elapsed = 0; elapsed < clockBudgetMs && !done; elapsed += CLOCK_STEP_MS) {
    await vi.advanceTimersByTimeAsync(CLOCK_STEP_MS);
  }
  await tracked;
  return outcome;
}

/**
 * A request that outlasts the activation budget unless the caller's signal
 * ends it — the shape that tells one shared deadline from a per-request one.
 */
function slowUnlessAborted<T>(value: T, durationMs: number) {
  return (_id: string, signal?: AbortSignal) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => resolve(value), durationMs);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new DOMException("This operation was aborted", "AbortError"));
        },
        { once: true }
      );
    });
}

describe("DaytonaSandboxProvider prebuilt images", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const prebuiltConfig = {
    ...baseCreateConfig,
    prebuiltImageId: "snapshot-1",
    prebuiltImageSha: "abc123",
  };

  it("spawns from the selected snapshot and marks the boot as prebuilt", async () => {
    const client = createBuildClient();
    client.createSandbox.mockResolvedValue({ id: "daytona-session-1", state: "started" });
    (client as unknown as Record<string, unknown>).getSignedPreviewUrl = vi.fn(async () => ({
      url: "https://preview.test/signed",
    }));

    await buildProvider(client).createSandbox(prebuiltConfig);

    const params = client.createSandbox.mock.calls[0][0];
    expect(params.snapshot).toBe("snapshot-1");
    expect(params.env).toMatchObject({
      FROM_REPO_IMAGE: "true",
      REPO_IMAGE_SHA: "abc123",
      IMAGE_BUILD_MODE: "false",
      RESTORED_FROM_SNAPSHOT: "false",
      OI_DEFERRED_START: "false",
    });
    // Presence of any callback key is what the runtime reads as a build
    // context, so a session create must set none of them.
    for (const key of Object.keys(params.env ?? {})) {
      expect(key.startsWith("OI_REPO_IMAGE_")).toBe(false);
    }
  });

  it("states every boot marker on a base-image spawn too", async () => {
    const client = createBuildClient();
    client.createSandbox.mockResolvedValue({ id: "daytona-session-1", state: "started" });
    (client as unknown as Record<string, unknown>).getSignedPreviewUrl = vi.fn(async () => ({
      url: "https://preview.test/signed",
    }));

    await buildProvider(client).createSandbox(baseCreateConfig);

    const params = client.createSandbox.mock.calls[0][0];
    expect(params.snapshot).toBe("base-snapshot-v1");
    expect(params.env).toMatchObject({
      FROM_REPO_IMAGE: "false",
      IMAGE_BUILD_MODE: "false",
      RESTORED_FROM_SNAPSHOT: "false",
      OI_DEFERRED_START: "false",
    });
    expect(params.env?.REPO_IMAGE_SHA).toBeUndefined();
  });

  it("activates a cold prebuilt image before using it", async () => {
    const client = createBuildClient({
      getSnapshot: vi
        .fn()
        .mockResolvedValueOnce({ id: "snapshot-1", name: "oi-image-abc", state: "inactive" })
        .mockResolvedValue({ id: "snapshot-1", name: "oi-image-abc", state: "active" }),
    });
    client.createSandbox.mockResolvedValue({ id: "daytona-session-1", state: "started" });
    (client as unknown as Record<string, unknown>).getSignedPreviewUrl = vi.fn(async () => ({
      url: "https://preview.test/signed",
    }));

    await buildProvider(client).createSandbox(prebuiltConfig);

    expect(client.activateSnapshot).toHaveBeenCalledWith("snapshot-1", expect.any(AbortSignal));
    expect(client.createSandbox).toHaveBeenCalled();
  });

  it("reports a still-waking image as pending rather than broken", async () => {
    vi.useFakeTimers();
    try {
      const client = createBuildClient({
        getSnapshot: vi.fn(async () => ({
          id: "snapshot-1",
          name: "oi-image-abc",
          state: "inactive",
        })),
      });

      const creating = buildProvider(client)
        .createSandbox(prebuiltConfig)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(await creating).toMatchObject({
        name: "PrebuiltImageActivationPendingError",
        errorType: "transient",
      });
      expect(client.createSandbox).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["missing", null],
    ["failed", { id: "snapshot-1", name: "oi-image-abc", state: "build_failed" }],
  ])("refuses a %s prebuilt image as permanently unusable", async (_name, snapshot) => {
    const client = createBuildClient({
      getSnapshot: vi.fn(async () => {
        if (!snapshot) throw new DaytonaNotFoundError("gone");
        return snapshot;
      }),
    });

    const error = await buildProvider(client)
      .createSandbox(prebuiltConfig)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SandboxProviderError);
    expect((error as SandboxProviderError).errorType).toBe("permanent");
    expect(error).not.toBeInstanceOf(PrebuiltImageActivationPendingError);
    expect(client.createSandbox).not.toHaveBeenCalled();
  });

  it.each([
    ["disappears", null] as const,
    [
      "starts being removed",
      { id: "snapshot-1", name: "oi-image-abc", state: "removing" },
    ] as const,
  ])("refuses a prebuilt image that %s during the activation wait", async (_name, secondRead) => {
    vi.useFakeTimers();
    try {
      const getSnapshot = vi.fn(async () => {
        if (getSnapshot.mock.calls.length === 1) {
          return { id: "snapshot-1", name: "oi-image-abc", state: "inactive" };
        }
        if (!secondRead) throw new DaytonaNotFoundError("gone");
        return secondRead;
      });
      const client = createBuildClient({ getSnapshot });

      const error = await buildProvider(client)
        .createSandbox(prebuiltConfig)
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(SandboxProviderError);
      expect(error).not.toBeInstanceOf(PrebuiltImageActivationPendingError);
      expect((error as SandboxProviderError).errorType).toBe("permanent");
      // The read that saw it go is the last one: no polling out the budget.
      expect(getSnapshot).toHaveBeenCalledTimes(2);
      expect(client.createSandbox).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds the whole activation flow by one budget, not each request", async () => {
    vi.useFakeTimers();
    try {
      const slowMs = ACTIVATION_BUDGET_MS - 5_000;
      const client = createBuildClient({
        getSnapshot: vi.fn(
          slowUnlessAborted({ id: "snapshot-1", name: "oi-image-abc", state: "inactive" }, slowMs)
        ),
        activateSnapshot: vi.fn(
          slowUnlessAborted({ id: "snapshot-1", name: "oi-image-abc", state: "pulling" }, slowMs)
        ),
      });

      const startedAt = Date.now();
      const error = await settleOnFakeClock(
        buildProvider(client).createSandbox(prebuiltConfig),
        ACTIVATION_BUDGET_MS * 8
      );
      const elapsedMs = Date.now() - startedAt;

      expect(error).toMatchObject({
        name: "PrebuiltImageActivationPendingError",
        errorType: "transient",
      });
      expect(elapsedMs).toBeLessThanOrEqual(ACTIVATION_BUDGET_MS + ACTIVATION_POLL_INTERVAL_MS);
      expect(client.createSandbox).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [
      "a rate-limited read",
      new DaytonaApiError("Daytona API error 429 on GET /snapshots: slow down", 429),
    ],
    [
      "an unavailable read",
      new DaytonaApiError("Daytona API error 503 on GET /snapshots: upstream gone", 503),
    ],
    ["a network failure", new TypeError("fetch failed")],
    ["a read that timed out", new DOMException("This operation was aborted", "AbortError")],
    ["a cancelled read", new DaytonaCancelledError()],
  ])("keeps the image in rotation when the snapshot read hits %s", async (_name, thrown) => {
    const client = createBuildClient({
      getSnapshot: vi.fn(async () => {
        throw thrown;
      }),
    });

    const error = await buildProvider(client)
      .createSandbox(prebuiltConfig)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PrebuiltImageActivationPendingError);
    // Status and nothing else: a provider body never rides the message.
    expect((error as Error).message).not.toMatch(/slow down|upstream gone/);
    expect(client.createSandbox).not.toHaveBeenCalled();
  });

  it("keeps the image in rotation when activation is rate-limited", async () => {
    const client = createBuildClient({
      getSnapshot: vi.fn(async () => ({
        id: "snapshot-1",
        name: "oi-image-abc",
        state: "inactive",
      })),
      activateSnapshot: vi.fn(async () => {
        throw new DaytonaApiError("Daytona API error 429 on POST /snapshots/activate", 429);
      }),
    });

    const error = await buildProvider(client)
      .createSandbox(prebuiltConfig)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PrebuiltImageActivationPendingError);
    expect(client.createSandbox).not.toHaveBeenCalled();
  });

  it("still fails permanently when the snapshot read is refused", async () => {
    const client = createBuildClient({
      getSnapshot: vi.fn(async () => {
        throw new DaytonaApiError("Daytona API error 401 on GET /snapshots", 401);
      }),
    });

    const error = await buildProvider(client)
      .createSandbox(prebuiltConfig)
      .catch((caught: unknown) => caught);

    // A rejected call says the deployment is wrong, not that the image is
    // cold: softening it would hide the fault behind slow spawns.
    expect(error).toBeInstanceOf(SandboxProviderError);
    expect(error).not.toBeInstanceOf(PrebuiltImageActivationPendingError);
    expect((error as SandboxProviderError).errorType).toBe("permanent");
    expect(client.createSandbox).not.toHaveBeenCalled();
  });

  it("keeps a created sandbox whose preview URLs cannot be issued", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = createBuildClient();
    client.createSandbox.mockResolvedValue({ id: "daytona-session-1", state: "started" });
    (client as unknown as Record<string, unknown>).getSignedPreviewUrl = vi.fn(async () => {
      throw new DaytonaApiError("preview unavailable", 500);
    });

    const result = await buildProvider(client).createSandbox({
      ...prebuiltConfig,
      codeServerEnabled: true,
      vncEnabled: true,
    });

    // The id is the only handle to a sandbox with no hard TTL: it is returned
    // rather than dropped, and the sandbox is left running.
    expect(result.providerObjectId).toBe("daytona-session-1");
    expect(result.codeServerUrl).toBeUndefined();
    expect(result.codeServerPassword).toBeUndefined();
    expect(result.vncAccess).toBeUndefined();
    expect(result.tunnelUrls).toBeUndefined();
    expect(client.deleteSandbox).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("daytona.create_tunnel_urls_failed"));
  });
});
