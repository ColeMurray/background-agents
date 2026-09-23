/**
 * Unit tests for DaytonaSandboxProvider.
 *
 * Tests env-var assembly, label construction, code-server password derivation,
 * tunnel URL generation, and error handling for create/resume/stop flows.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { computeHmacHex } from "@open-inspect/shared/auth";
import { DEFAULT_TERMINAL_PORT } from "@open-inspect/shared/types/integrations";
import { deriveVncPassword } from "../sandbox-env";
import { DaytonaSandboxProvider, type DaytonaProviderConfig } from "./daytona-provider";
import {
  PrebuiltImageActivationPendingError,
  PrebuiltImageUnavailableError,
  SandboxProviderError,
} from "../provider";
import type { CreateSandboxConfig, ResumeConfig, StopConfig } from "../provider";
import {
  DaytonaNotFoundError,
  DaytonaApiError,
  DaytonaCancelledError,
  type DaytonaRestClient,
  type DaytonaSandboxResponse,
  type DaytonaSignedPreviewUrlResponse,
  type DaytonaCreateSandboxParams,
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
  intent: "preserve",
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
      expect(result.lifetime).toMatchObject({ kind: "none" });

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
        bridge_early_connect: true,
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
      expect(client.getSignedPreviewUrl).not.toHaveBeenCalled();
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
      const client = createMockClient({
        getSandbox: async () => ({ id: "daytona-sandbox-id", state: "stopped" }),
      });
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      const result = await provider.stopSandbox(baseStopConfig);

      expect(result.success).toBe(true);
      expect(client.stopSandbox).toHaveBeenCalledWith("daytona-sandbox-id");
    });

    it("deletes sandbox on replacement", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);
      const signal = AbortSignal.timeout(1_000);

      const result = await provider.stopSandbox({
        ...baseStopConfig,
        reason: "respawn",
        intent: "destroy",
        signal,
      });

      expect(result.success).toBe(true);
      expect(client.deleteSandbox).toHaveBeenCalledWith("daytona-sandbox-id", signal);
      expect(client.stopSandbox).not.toHaveBeenCalled();
    });

    it("returns success when sandbox not found (already gone)", async () => {
      const client = createMockClient({
        deleteSandbox: async () => {
          throw new DaytonaNotFoundError("not found");
        },
      });
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig);

      const result = await provider.stopSandbox({ ...baseStopConfig, intent: "destroy" });

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

// ==================== Prebuilt images ====================

/** A client mock with the snapshot surface a prebuilt spawn exercises. */
function createPrebuiltClient(overrides: Record<string, unknown> = {}) {
  const config = { ...defaultRestConfig };
  return {
    config,
    requireBaseSnapshot: vi.fn(() => config.baseSnapshot as string),
    createSandbox: vi.fn(
      async (_params: DaytonaCreateSandboxParams): Promise<DaytonaSandboxResponse> => ({
        id: "daytona-session-1",
        state: "started",
      })
    ),
    deleteSandbox: vi.fn(async () => undefined),
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
    ...overrides,
  };
}

function prebuiltProvider(client: ReturnType<typeof createPrebuiltClient>) {
  return new DaytonaSandboxProvider(client as unknown as DaytonaRestClient, defaultProviderConfig);
}

/** Mirrors PREBUILT_ACTIVATION_TIMEOUT_MS in daytona-provider.ts. */
const ACTIVATION_BUDGET_MS = 45_000;
/** Mirrors LIFECYCLE_POLL_INTERVAL_MS in daytona-lifecycle.ts. */
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
    const client = createPrebuiltClient();
    client.createSandbox.mockResolvedValue({ id: "daytona-session-1", state: "started" });
    (client as unknown as Record<string, unknown>).getSignedPreviewUrl = vi.fn(async () => ({
      url: "https://preview.test/signed",
    }));

    const result = await prebuiltProvider(client).createSandbox({
      ...prebuiltConfig,
      sandboxSettings: { terminalEnabled: true },
    });

    const params = client.createSandbox.mock.calls[0][0];
    expect(params.snapshot).toBe("snapshot-1");
    expect(params.env).toMatchObject({
      FROM_REPO_IMAGE: "true",
      REPO_IMAGE_SHA: "abc123",
      IMAGE_BUILD_MODE: "false",
      RESTORED_FROM_SNAPSHOT: "false",
      OI_DEFERRED_START: "false",
      TERMINAL_ENABLED: "true",
      TTYD_PROXY_PORT: String(DEFAULT_TERMINAL_PORT),
    });
    expect(result.ttydUrl).toBe("https://preview.test/signed");
    // Presence of any callback key is what the runtime reads as a build
    // context, so a session create must set none of them.
    for (const key of Object.keys(params.env ?? {})) {
      expect(key.startsWith("OI_REPO_IMAGE_")).toBe(false);
    }
  });

  it("states every boot marker on a base-image spawn too", async () => {
    const client = createPrebuiltClient();
    client.createSandbox.mockResolvedValue({ id: "daytona-session-1", state: "started" });
    (client as unknown as Record<string, unknown>).getSignedPreviewUrl = vi.fn(async () => ({
      url: "https://preview.test/signed",
    }));

    await prebuiltProvider(client).createSandbox(baseCreateConfig);

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
    const client = createPrebuiltClient({
      getSnapshot: vi
        .fn()
        .mockResolvedValueOnce({ id: "snapshot-1", name: "oi-image-abc", state: "inactive" })
        .mockResolvedValue({ id: "snapshot-1", name: "oi-image-abc", state: "active" }),
    });
    client.createSandbox.mockResolvedValue({ id: "daytona-session-1", state: "started" });
    (client as unknown as Record<string, unknown>).getSignedPreviewUrl = vi.fn(async () => ({
      url: "https://preview.test/signed",
    }));

    await prebuiltProvider(client).createSandbox(prebuiltConfig);

    expect(client.activateSnapshot).toHaveBeenCalledWith("snapshot-1", expect.any(AbortSignal));
    expect(client.createSandbox).toHaveBeenCalled();
  });

  it("reports a still-waking image as pending rather than broken", async () => {
    vi.useFakeTimers();
    try {
      const client = createPrebuiltClient({
        getSnapshot: vi.fn(async () => ({
          id: "snapshot-1",
          name: "oi-image-abc",
          state: "inactive",
        })),
      });

      const creating = prebuiltProvider(client)
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
    const client = createPrebuiltClient({
      getSnapshot: vi.fn(async () => {
        if (!snapshot) throw new DaytonaNotFoundError("gone");
        return snapshot;
      }),
    });

    const error = await prebuiltProvider(client)
      .createSandbox(prebuiltConfig)
      .catch((thrown: unknown) => thrown);

    // Unavailable is the classification that retires the image: the row is
    // failed and the next reconciliation rebuilds it.
    expect(error).toBeInstanceOf(PrebuiltImageUnavailableError);
    expect((error as SandboxProviderError).errorType).toBe("permanent");
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
      const client = createPrebuiltClient({ getSnapshot });

      const error = await prebuiltProvider(client)
        .createSandbox(prebuiltConfig)
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(PrebuiltImageUnavailableError);
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
      const client = createPrebuiltClient({
        getSnapshot: vi.fn(
          slowUnlessAborted({ id: "snapshot-1", name: "oi-image-abc", state: "inactive" }, slowMs)
        ),
        activateSnapshot: vi.fn(
          slowUnlessAborted({ id: "snapshot-1", name: "oi-image-abc", state: "pulling" }, slowMs)
        ),
      });

      const startedAt = Date.now();
      const error = await settleOnFakeClock(
        prebuiltProvider(client).createSandbox(prebuiltConfig),
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
    const client = createPrebuiltClient({
      getSnapshot: vi.fn(async () => {
        throw thrown;
      }),
    });

    const error = await prebuiltProvider(client)
      .createSandbox(prebuiltConfig)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PrebuiltImageActivationPendingError);
    // Status and nothing else: a provider body never rides the message.
    expect((error as Error).message).not.toMatch(/slow down|upstream gone/);
    expect(client.createSandbox).not.toHaveBeenCalled();
  });

  it("keeps the image in rotation when activation is rate-limited", async () => {
    const client = createPrebuiltClient({
      getSnapshot: vi.fn(async () => ({
        id: "snapshot-1",
        name: "oi-image-abc",
        state: "inactive",
      })),
      activateSnapshot: vi.fn(async () => {
        throw new DaytonaApiError("Daytona API error 429 on POST /snapshots/activate", 429);
      }),
    });

    const error = await prebuiltProvider(client)
      .createSandbox(prebuiltConfig)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PrebuiltImageActivationPendingError);
    expect(client.createSandbox).not.toHaveBeenCalled();
  });

  it("still fails permanently when the snapshot read is refused", async () => {
    const client = createPrebuiltClient({
      getSnapshot: vi.fn(async () => {
        throw new DaytonaApiError("Daytona API error 401 on GET /snapshots", 401);
      }),
    });

    const error = await prebuiltProvider(client)
      .createSandbox(prebuiltConfig)
      .catch((caught: unknown) => caught);

    // A rejected call says the deployment is wrong, not that the image is
    // cold: softening it would hide the fault behind slow spawns. It says
    // nothing about the artifact either, so it must not retire the image.
    expect(error).toBeInstanceOf(SandboxProviderError);
    expect(error).not.toBeInstanceOf(PrebuiltImageActivationPendingError);
    expect(error).not.toBeInstanceOf(PrebuiltImageUnavailableError);
    expect((error as SandboxProviderError).errorType).toBe("permanent");
    expect(client.createSandbox).not.toHaveBeenCalled();
  });

  it("keeps a created sandbox whose preview URLs cannot be issued", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = createPrebuiltClient();
    client.createSandbox.mockResolvedValue({ id: "daytona-session-1", state: "started" });
    (client as unknown as Record<string, unknown>).getSignedPreviewUrl = vi.fn(async () => {
      throw new DaytonaApiError("preview unavailable", 500);
    });

    const result = await prebuiltProvider(client).createSandbox({
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
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("daytona.preview_url_failed"));
  });
});
