/**
 * Unit tests for DaytonaSandboxProvider.
 *
 * Tests env-var assembly, label construction, code-server password derivation,
 * tunnel URL generation, and error handling for create/resume/stop flows.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { computeHmacHex } from "@open-inspect/shared";
import { DaytonaSandboxProvider, type DaytonaProviderConfig } from "./daytona-provider";
import { SandboxProviderError } from "../provider";
import type { CreateSandboxConfig, ResumeConfig, StopConfig } from "../provider";
import {
  DaytonaNotFoundError,
  DaytonaApiError,
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
    recoverSandbox: (id: string) => Promise<void>;
    getSignedPreviewUrl: (
      id: string,
      port: number,
      expiry: number
    ) => Promise<DaytonaSignedPreviewUrlResponse>;
  }> = {},
  configOverrides: Partial<DaytonaRestConfig> = {}
): DaytonaRestClient {
  return {
    config: { ...defaultRestConfig, ...configOverrides },
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
  codeServerPasswordSecret: "test-secret-key",
};

const defaultGetCloneToken = vi.fn(async () => "ghs_test_clone_token");

const baseCreateConfig: CreateSandboxConfig = {
  sessionId: "session-123",
  sandboxId: "sandbox-456",
  repoOwner: "testowner",
  repoName: "testrepo",
  controlPlaneUrl: "https://control-plane.test",
  sandboxAuthToken: "auth-token-abc",
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
  beforeEach(() => {
    defaultGetCloneToken.mockResolvedValue("ghs_test_clone_token");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("capabilities", () => {
    it("reports correct capabilities", () => {
      const provider = new DaytonaSandboxProvider(
        createMockClient(),
        defaultProviderConfig,
        defaultGetCloneToken
      );
      expect(provider.name).toBe("daytona");
      expect(provider.capabilities).toEqual({
        supportsSnapshots: false,
        supportsRestore: false,
        supportsWarm: false,
        supportsPersistentResume: true,
        supportsExplicitStop: true,
      });
    });
  });

  describe("createSandbox", () => {
    it("happy path: creates sandbox with env vars, labels, and tunnel URLs", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(
        client,
        defaultProviderConfig,
        defaultGetCloneToken
      );

      const result = await provider.createSandbox(baseCreateConfig);

      expect(result.sandboxId).toBe("sandbox-456");
      expect(result.providerObjectId).toBe("daytona-sandbox-id");
      expect(result.status).toBe("started");
      expect(result.createdAt).toBeGreaterThan(0);

      // Verify create was called with correct params
      const createCall = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.name).toBe("sandbox-456");
      expect(createCall.snapshot).toBe("base-snapshot-v1");
      expect(createCall.auto_stop_interval).toBe(120);
      expect(createCall.auto_archive_interval).toBe(10080);
      expect(createCall.public).toBe(false);
    });

    it("assembles env vars correctly for GitHub", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(
        client,
        defaultProviderConfig,
        defaultGetCloneToken
      );

      await provider.createSandbox(baseCreateConfig);

      const createCall = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const envVars = createCall.env_vars;

      expect(envVars.PYTHONUNBUFFERED).toBe("1");
      expect(envVars.SANDBOX_ID).toBe("sandbox-456");
      expect(envVars.CONTROL_PLANE_URL).toBe("https://control-plane.test");
      expect(envVars.SANDBOX_AUTH_TOKEN).toBe("auth-token-abc");
      expect(envVars.REPO_OWNER).toBe("testowner");
      expect(envVars.REPO_NAME).toBe("testrepo");
      expect(envVars.VCS_HOST).toBe("github.com");
      expect(envVars.VCS_CLONE_USERNAME).toBe("x-access-token");
      expect(envVars.VCS_CLONE_TOKEN).toBe("ghs_test_clone_token");
      expect(envVars.GITHUB_APP_TOKEN).toBe("ghs_test_clone_token");
      expect(envVars.GITHUB_TOKEN).toBe("ghs_test_clone_token");

      const sessionConfig = JSON.parse(envVars.SESSION_CONFIG);
      expect(sessionConfig).toEqual({
        session_id: "session-123",
        repo_owner: "testowner",
        repo_name: "testrepo",
        provider: "anthropic",
        model: "anthropic/claude-sonnet-4-5",
      });
    });

    it("assembles env vars correctly for GitLab", async () => {
      const client = createMockClient();
      const getCloneToken = vi.fn(async () => "glpat-test-token");
      const provider = new DaytonaSandboxProvider(
        client,
        {
          scmProvider: "gitlab",
          gitlabAccessToken: "glpat-test-token",
          codeServerPasswordSecret: "secret",
        },
        getCloneToken
      );

      await provider.createSandbox(baseCreateConfig);

      const envVars = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0].env_vars;
      expect(envVars.VCS_HOST).toBe("gitlab.com");
      expect(envVars.VCS_CLONE_USERNAME).toBe("oauth2");
      expect(envVars.VCS_CLONE_TOKEN).toBe("glpat-test-token");
      // GitLab should NOT set GITHUB_APP_TOKEN or GITHUB_TOKEN
      expect(envVars.GITHUB_APP_TOKEN).toBeUndefined();
      expect(envVars.GITHUB_TOKEN).toBeUndefined();
    });

    it("includes branch in SESSION_CONFIG when provided", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(
        client,
        defaultProviderConfig,
        defaultGetCloneToken
      );

      await provider.createSandbox({ ...baseCreateConfig, branch: "feature/test" });

      const envVars = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0].env_vars;
      const sessionConfig = JSON.parse(envVars.SESSION_CONFIG);
      expect(sessionConfig.branch).toBe("feature/test");
    });

    it("includes user env vars (repo secrets) with system vars taking precedence", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(
        client,
        defaultProviderConfig,
        defaultGetCloneToken
      );

      await provider.createSandbox({
        ...baseCreateConfig,
        userEnvVars: { MY_SECRET: "value123", SANDBOX_ID: "should-be-overridden" },
      });

      const envVars = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0].env_vars;
      expect(envVars.MY_SECRET).toBe("value123");
      // System var overrides user-provided duplicate
      expect(envVars.SANDBOX_ID).toBe("sandbox-456");
    });

    it("builds labels correctly", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(
        client,
        defaultProviderConfig,
        defaultGetCloneToken
      );

      await provider.createSandbox(baseCreateConfig);

      const labels = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0].labels;
      expect(labels).toEqual({
        openinspect_framework: "open-inspect",
        openinspect_session_id: "session-123",
        openinspect_repo: "testowner/testrepo",
        openinspect_expected_sandbox_id: "sandbox-456",
      });
    });

    it("passes target to create params when set", async () => {
      const client = createMockClient({}, { target: "us-east-1" });
      const provider = new DaytonaSandboxProvider(
        client,
        defaultProviderConfig,
        defaultGetCloneToken
      );

      await provider.createSandbox(baseCreateConfig);

      const createCall = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.target).toBe("us-east-1");
    });

    it("omits target from create params when not set", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(
        client,
        defaultProviderConfig,
        defaultGetCloneToken
      );

      await provider.createSandbox(baseCreateConfig);

      const createCall = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(createCall.target).toBeUndefined();
    });

    it("handles null clone token gracefully", async () => {
      const client = createMockClient();
      const getCloneToken = vi.fn(async () => null);
      const provider = new DaytonaSandboxProvider(client, defaultProviderConfig, getCloneToken);

      await provider.createSandbox(baseCreateConfig);

      const envVars = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0].env_vars;
      expect(envVars.VCS_CLONE_TOKEN).toBeUndefined();
      expect(envVars.GITHUB_APP_TOKEN).toBeUndefined();
    });

    it("classifies DaytonaApiError as SandboxProviderError", async () => {
      const client = createMockClient({
        createSandbox: async () => {
          throw new DaytonaApiError("quota exceeded", 422);
        },
      });
      const provider = new DaytonaSandboxProvider(
        client,
        defaultProviderConfig,
        defaultGetCloneToken
      );

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
      const provider = new DaytonaSandboxProvider(
        client,
        defaultProviderConfig,
        defaultGetCloneToken
      );

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
      const provider = new DaytonaSandboxProvider(
        client,
        defaultProviderConfig,
        defaultGetCloneToken
      );

      await provider.createSandbox({
        ...baseCreateConfig,
        codeServerEnabled: true,
      });

      const envVars = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0].env_vars;
      const expectedDigest = await computeHmacHex("code-server:sandbox-456", "test-secret-key");
      expect(envVars.CODE_SERVER_PASSWORD).toBe(expectedDigest.slice(0, 32));
      expect(envVars.CODE_SERVER_PASSWORD).toHaveLength(32);
    });

    it("does not set CODE_SERVER_PASSWORD when disabled", async () => {
      const client = createMockClient();
      const provider = new DaytonaSandboxProvider(
        client,
        defaultProviderConfig,
        defaultGetCloneToken
      );

      await provider.createSandbox(baseCreateConfig);

      const envVars = (client.createSandbox as ReturnType<typeof vi.fn>).mock.calls[0][0].env_vars;
      expect(envVars.CODE_SERVER_PASSWORD).toBeUndefined();
    });
  });

  describe("resumeSandbox", () => {
    it("happy path: resumes a stopped sandbox", async () => {
      const client = createMockClient({
        getSandbox: async () => ({ id: "daytona-sandbox-id", state: "stopped" }),
      });
      const provider = new DaytonaSandboxProvider(
        client,
        defaultProviderConfig,
        defaultGetCloneToken
      );

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
      const provider = new DaytonaSandboxProvider(
        client,
        defaultProviderConfig,
        defaultGetCloneToken
      );

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
      const provider = new DaytonaSandboxProvider(
        client,
        defaultProviderConfig,
        defaultGetCloneToken
      );

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
      const provider = new DaytonaSandboxProvider(
        client,
        defaultProviderConfig,
        defaultGetCloneToken
      );

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
      const provider = new DaytonaSandboxProvider(
        client,
        defaultProviderConfig,
        defaultGetCloneToken
      );

      await provider.resumeSandbox(baseResumeConfig);

      expect(client.startSandbox).toHaveBeenCalledWith("daytona-sandbox-id");
      expect(client.recoverSandbox).not.toHaveBeenCalled();
    });

    it("does not start or recover when already started", async () => {
      const client = createMockClient({
        getSandbox: async () => ({ id: "daytona-sandbox-id", state: "started" }),
      });
      const provider = new DaytonaSandboxProvider(
        client,
        defaultProviderConfig,
        defaultGetCloneToken
      );

      const result = await provider.resumeSandbox(baseResumeConfig);

      expect(result.success).toBe(true);
      expect(client.startSandbox).not.toHaveBeenCalled();
      expect(client.recoverSandbox).not.toHaveBeenCalled();
    });

    it("tunnel URL failure does not fail the resume", async () => {
      const client = createMockClient({
        getSandbox: async () => ({ id: "daytona-sandbox-id", state: "stopped" }),
        getSignedPreviewUrl: async () => {
          throw new Error("tunnel service down");
        },
      });
      const provider = new DaytonaSandboxProvider(
        client,
        defaultProviderConfig,
        defaultGetCloneToken
      );

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
      const provider = new DaytonaSandboxProvider(
        client,
        defaultProviderConfig,
        defaultGetCloneToken
      );

      const result = await provider.stopSandbox(baseStopConfig);

      expect(result.success).toBe(true);
      expect(client.stopSandbox).toHaveBeenCalledWith("daytona-sandbox-id");
    });

    it("returns success when sandbox not found (already gone)", async () => {
      const client = createMockClient({
        stopSandbox: async () => {
          throw new DaytonaNotFoundError("not found");
        },
      });
      const provider = new DaytonaSandboxProvider(
        client,
        defaultProviderConfig,
        defaultGetCloneToken
      );

      const result = await provider.stopSandbox(baseStopConfig);

      expect(result.success).toBe(true);
    });

    it("classifies non-404 errors as SandboxProviderError", async () => {
      const client = createMockClient({
        stopSandbox: async () => {
          throw new DaytonaApiError("service unavailable", 503);
        },
      });
      const provider = new DaytonaSandboxProvider(
        client,
        defaultProviderConfig,
        defaultGetCloneToken
      );

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
