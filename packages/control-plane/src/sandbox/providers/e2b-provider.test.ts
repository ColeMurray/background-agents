import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeHmacHex } from "@open-inspect/shared";
import { E2BSandboxProvider, type E2BProviderConfig } from "./e2b-provider";
import { SandboxProviderError } from "../provider";
import {
  E2BNotFoundError,
  E2BConflictError,
  E2BApiError,
  type E2BRestClient,
  type E2BSandboxDetail,
} from "../e2b-rest-client";

const providerConfig: E2BProviderConfig = {
  scmProvider: "github",
  codeServerPasswordSecret: "secret",
  sandboxTimeoutSeconds: 1800,
  runtimeCapSeconds: 1800,
};

function mockClient(overrides: Partial<E2BRestClient> = {}): E2BRestClient {
  return {
    config: { apiUrl: "https://api.e2b.app", apiKey: "secret", templateId: "tmpl" },
    createSandbox: vi.fn(async () => ({ sandboxID: "e2b-id", templateID: "tmpl" })),
    writeSessionEnv: vi.fn(async () => {}),
    getSandbox: vi.fn(
      async (): Promise<E2BSandboxDetail> => ({
        sandboxID: "e2b-id",
        templateID: "tmpl",
        state: "paused",
      })
    ),
    pauseSandbox: vi.fn(async () => {}),
    connectSandbox: vi.fn(
      async (): Promise<E2BSandboxDetail> => ({
        sandboxID: "e2b-id",
        templateID: "tmpl",
        state: "running",
      })
    ),
    killSandbox: vi.fn(async () => {}),
    setSandboxTimeout: vi.fn(async () => {}),
    refreshKeepalive: vi.fn(async () => {}),
    getHostnameForPort: vi.fn((id: string, port: number) => `https://${port}-${id}.e2b.app`),
    ...overrides,
  } as unknown as E2BRestClient;
}

const baseCreateConfig = {
  sessionId: "sess-1",
  sandboxId: "sandbox-logical",
  repoOwner: "o",
  repoName: "r",
  controlPlaneUrl: "https://cp.test",
  sandboxAuthToken: "tok",
  provider: "anthropic",
  model: "claude",
  codeServerEnabled: true,
};

describe("E2BSandboxProvider", () => {
  beforeEach(() => vi.clearAllMocks());

  it("createSandbox returns running status and tunnel urls", async () => {
    const client = mockClient();
    const provider = new E2BSandboxProvider(client, providerConfig);
    const result = await provider.createSandbox(baseCreateConfig);
    expect(result.status).toBe("running");
    expect(result.providerObjectId).toBe("e2b-id");
    expect(result.codeServerUrl).toBe("https://8080-e2b-id.e2b.app");
    const expected = (await computeHmacHex("code-server:sandbox-logical", "secret")).slice(0, 32);
    expect(result.codeServerPassword).toBe(expected);
  });

  it("system vars override user vars (delivered via writeSessionEnv)", async () => {
    const client = mockClient();
    const provider = new E2BSandboxProvider(client, providerConfig);
    await provider.createSandbox({ ...baseCreateConfig, userEnvVars: { SANDBOX_ID: "evil" } });
    // Per-session env is delivered as a file, not via POST /sandboxes envVars.
    expect(client.createSandbox).toHaveBeenCalledWith(
      expect.not.objectContaining({ envVars: expect.anything() })
    );
    const [sbxId, env] = vi.mocked(client.writeSessionEnv).mock.calls[0];
    expect(sbxId).toBe("e2b-id");
    expect(env.SANDBOX_ID).toBe("sandbox-logical");
    // Token-free: git auth is brokered per-request via the credential helper,
    // never embedded in sandbox env (would expire on long-running/resumed sessions).
    expect(env).not.toHaveProperty("VCS_CLONE_TOKEN");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env).not.toHaveProperty("GITHUB_APP_TOKEN");
  });

  it("resumeSandbox paused uses connectSandbox", async () => {
    const client = mockClient();
    const provider = new E2BSandboxProvider(client, providerConfig);
    const result = await provider.resumeSandbox({
      providerObjectId: "e2b-id",
      sessionId: "sess",
      sandboxId: "sandbox-logical",
    });
    expect(result.success).toBe(true);
    expect(client.connectSandbox).toHaveBeenCalledWith("e2b-id", 1800);
  });

  it("resumeSandbox running uses setSandboxTimeout only", async () => {
    const client = mockClient({
      getSandbox: vi.fn(async () => ({
        sandboxID: "e2b-id",
        templateID: "tmpl",
        state: "running",
      })),
    });
    const provider = new E2BSandboxProvider(client, providerConfig);
    await provider.resumeSandbox({
      providerObjectId: "e2b-id",
      sessionId: "sess",
      sandboxId: "sandbox-logical",
    });
    expect(client.setSandboxTimeout).toHaveBeenCalledWith("e2b-id", 1800);
    expect(client.connectSandbox).not.toHaveBeenCalled();
  });

  it("resumeSandbox 404 returns shouldSpawnFresh", async () => {
    const client = mockClient({
      getSandbox: vi.fn(async () => {
        throw new E2BNotFoundError("gone");
      }),
    });
    const provider = new E2BSandboxProvider(client, providerConfig);
    const result = await provider.resumeSandbox({
      providerObjectId: "e2b-id",
      sessionId: "sess",
      sandboxId: "sandbox-logical",
    });
    expect(result.shouldSpawnFresh).toBe(true);
  });

  it("pauseSandbox treats 404/409 as success", async () => {
    const client404 = mockClient({
      pauseSandbox: vi.fn(async () => {
        throw new E2BNotFoundError("gone");
      }),
    });
    expect(
      (
        await new E2BSandboxProvider(client404, providerConfig).pauseSandbox({
          providerObjectId: "x",
          sessionId: "s",
          reason: "idle",
        })
      ).success
    ).toBe(true);

    const client409 = mockClient({
      pauseSandbox: vi.fn(async () => {
        throw new E2BConflictError("already paused");
      }),
    });
    expect(
      (
        await new E2BSandboxProvider(client409, providerConfig).pauseSandbox({
          providerObjectId: "x",
          sessionId: "s",
          reason: "idle",
        })
      ).success
    ).toBe(true);
  });

  it("onUserActivity throttles refresh calls", async () => {
    const client = mockClient();
    const provider = new E2BSandboxProvider(client, providerConfig);
    await provider.onUserActivity({ providerObjectId: "e2b-id", sessionId: "sess" });
    await provider.onUserActivity({ providerObjectId: "e2b-id", sessionId: "sess" });
    expect(client.refreshKeepalive).toHaveBeenCalledTimes(1);
  });

  it("onUserActivity coalesces concurrent calls into one refresh", async () => {
    // Both calls see the stale lastActivityRefreshMs; the in-flight guard must
    // stop the second from firing a duplicate refresh before the first resolves.
    let release: () => void = () => {};
    const client = mockClient({
      refreshKeepalive: vi.fn(() => new Promise<void>((r) => (release = r))),
    });
    const provider = new E2BSandboxProvider(client, providerConfig);
    const a = provider.onUserActivity({ providerObjectId: "e2b-id", sessionId: "sess" });
    const b = provider.onUserActivity({ providerObjectId: "e2b-id", sessionId: "sess" });
    release();
    await Promise.all([a, b]);
    expect(client.refreshKeepalive).toHaveBeenCalledTimes(1);
  });

  it("honors config.timeoutSeconds on create and resume (child sandboxes)", async () => {
    const client = mockClient();
    const provider = new E2BSandboxProvider(client, providerConfig);

    await provider.createSandbox({ ...baseCreateConfig, timeoutSeconds: 3600 });
    expect(client.createSandbox).toHaveBeenCalledWith(expect.objectContaining({ timeout: 3600 }));

    await provider.resumeSandbox({
      providerObjectId: "e2b-id",
      sessionId: "sess",
      sandboxId: "sandbox-logical",
      timeoutSeconds: 3600,
    });
    expect(client.connectSandbox).toHaveBeenCalledWith("e2b-id", 3600);
  });

  it("falls back to the provider default timeout when config has none", async () => {
    const client = mockClient();
    const provider = new E2BSandboxProvider(client, providerConfig);
    await provider.createSandbox(baseCreateConfig);
    expect(client.createSandbox).toHaveBeenCalledWith(expect.objectContaining({ timeout: 1800 }));
  });

  it("kills the created sandbox when writeSessionEnv fails (no leak)", async () => {
    const client = mockClient({
      writeSessionEnv: vi.fn(async () => {
        throw new E2BApiError("envd unreachable", 502);
      }),
    });
    const provider = new E2BSandboxProvider(client, providerConfig);

    await expect(provider.createSandbox(baseCreateConfig)).rejects.toBeInstanceOf(
      SandboxProviderError
    );
    expect(client.killSandbox).toHaveBeenCalledWith("e2b-id");
  });

  it("still surfaces the original error when the cleanup kill also fails", async () => {
    const client = mockClient({
      writeSessionEnv: vi.fn(async () => {
        throw new E2BApiError("envd unreachable", 502);
      }),
      killSandbox: vi.fn(async () => {
        throw new E2BApiError("kill failed too", 500);
      }),
    });
    const provider = new E2BSandboxProvider(client, providerConfig);
    await expect(provider.createSandbox(baseCreateConfig)).rejects.toMatchObject({
      message: expect.stringContaining("envd unreachable"),
    });
  });

  it("threads the sandbox domain into code-server and tunnel URLs", async () => {
    const client = mockClient({
      createSandbox: vi.fn(async () => ({
        sandboxID: "e2b-id",
        templateID: "tmpl",
        domain: "dedicated.example",
      })),
      getHostnameForPort: vi.fn(
        (id: string, port: number, domain?: string | null) =>
          `https://${port}-${id}.${domain || "e2b.app"}`
      ),
    });
    const provider = new E2BSandboxProvider(client, providerConfig);
    const result = await provider.createSandbox(baseCreateConfig);
    expect(result.codeServerUrl).toBe("https://8080-e2b-id.dedicated.example");
  });

  it("shouldResetRuntime is disabled when runtimeCapSeconds is 0 (paid plans)", async () => {
    const client = mockClient();
    const provider = new E2BSandboxProvider(client, {
      ...providerConfig,
      runtimeCapSeconds: 0,
    });
    const result = await provider.shouldResetRuntime({
      providerObjectId: "e2b-id",
      startedAtMs: 0,
      nowMs: 100 * 60 * 60 * 1000, // far past any cap
    });
    expect(result.shouldReset).toBe(false);
  });

  it("429 maps to a TRANSIENT SandboxProviderError (not counted toward the circuit breaker)", async () => {
    const client = mockClient({
      createSandbox: vi.fn(async () => {
        throw new E2BApiError("rate limited", 429);
      }),
    });
    const provider = new E2BSandboxProvider(client, providerConfig);
    await expect(provider.createSandbox(baseCreateConfig)).rejects.toMatchObject({
      errorType: "transient",
      message: expect.stringContaining("rate-limited"),
    } satisfies Partial<SandboxProviderError>);
  });

  it("SESSION_CONFIG carries mcp_servers and the multi-repo repositories list", async () => {
    const client = mockClient();
    const provider = new E2BSandboxProvider(client, providerConfig);
    await provider.createSandbox({
      ...baseCreateConfig,
      mcpServers: [{ id: "m1", name: "linear", type: "remote", url: "https://mcp", enabled: true }],
      repositories: [
        { repoOwner: "o", repoName: "r", baseBranch: "main" },
        { repoOwner: "o2", repoName: "r2", baseBranch: "dev" },
      ],
    });
    const [, env] = vi.mocked(client.writeSessionEnv).mock.calls[0];
    const sessionConfig = JSON.parse(env.SESSION_CONFIG);
    expect(sessionConfig.mcp_servers).toHaveLength(1);
    expect(sessionConfig.repositories).toEqual([
      { repo_owner: "o", repo_name: "r", branch: "main" },
      { repo_owner: "o2", repo_name: "r2", branch: "dev" },
    ]);
  });

  it("emits CODE_SERVER_PORT (default, and a custom configured port)", async () => {
    const client = mockClient();
    const provider = new E2BSandboxProvider(client, providerConfig);

    await provider.createSandbox(baseCreateConfig);
    expect(vi.mocked(client.writeSessionEnv).mock.calls[0][1].CODE_SERVER_PORT).toBe("8080");

    vi.clearAllMocks();
    const result = await provider.createSandbox({
      ...baseCreateConfig,
      sandboxSettings: { codeServerPort: 9999 } as never,
    });
    expect(vi.mocked(client.writeSessionEnv).mock.calls[0][1].CODE_SERVER_PORT).toBe("9999");
    // The configured port must drive the code-server URL too, not a hardcoded 8080.
    expect(result.codeServerUrl).toBe("https://9999-e2b-id.e2b.app");
  });

  it("onUserActivity refreshes with the sandbox's effective timeout, not the provider default", async () => {
    const client = mockClient();
    const provider = new E2BSandboxProvider(client, providerConfig);
    // Child sandbox created with a longer TTL (> E2B's 1h single-refresh cap).
    await provider.createSandbox({ ...baseCreateConfig, timeoutSeconds: 7200 });

    await provider.onUserActivity({ providerObjectId: "e2b-id", sessionId: "sess" });
    // Uses setSandboxTimeout(7200) — the effective TTL — not refreshKeepalive at the 1800 default.
    expect(client.setSandboxTimeout).toHaveBeenCalledWith("e2b-id", 7200);
    expect(client.refreshKeepalive).not.toHaveBeenCalled();
  });
});
