import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeHmacHex } from "@open-inspect/shared/auth";
import { deriveVncPassword } from "../sandbox-env";
import { E2BSandboxProvider, E2B_SANDBOX_VERSION, type E2BProviderConfig } from "./e2b-provider";
import {
  MIN_COMPATIBLE_RUNTIME_VERSION,
  parseRuntimeVersionNumber,
} from "../../image-builds/model";
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
  sandboxAccessPasswordSecret: "secret",
  sandboxTimeoutSeconds: 1800,
  autoPause: true,
};

function mockClient(overrides: Partial<E2BRestClient> = {}): E2BRestClient {
  return {
    config: { apiUrl: "https://api.e2b.app", apiKey: "secret", templateId: "tmpl" },
    createSandbox: vi.fn(async () => ({
      sandboxID: "e2b-id",
      templateID: "tmpl",
      envdAccessToken: "envd-token",
    })),
    writeSessionEnv: vi.fn(async () => {}),
    getSandbox: vi.fn(
      async (): Promise<E2BSandboxDetail> => ({
        sandboxID: "e2b-id",
        templateID: "tmpl",
        state: "paused",
      })
    ),
    pauseSandbox: vi.fn(async () => {}),
    connectSandbox: vi.fn(async () => {}),
    updateSandboxNetwork: vi.fn(async () => {}),
    startProcess: vi.fn(async () => {}),
    killSandbox: vi.fn(async () => {}),
    setSandboxTimeout: vi.fn(async () => {}),
    createSnapshot: vi.fn(async () => ({ snapshotID: "snap-abc:default", names: ["oi/snap"] })),
    deleteTemplate: vi.fn(async () => {}),
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

  it("injects and returns VNC access without including its port in generic tunnels", async () => {
    const client = mockClient();
    const provider = new E2BSandboxProvider(client, providerConfig);
    const result = await provider.createSandbox({
      ...baseCreateConfig,
      vncEnabled: true,
      sandboxSettings: { vncPort: 6099, tunnelPorts: [6099, 3000] },
    });
    const [, env] = vi.mocked(client.writeSessionEnv).mock.calls[0];
    const expected = await deriveVncPassword("sandbox-logical", "secret");

    expect(env).toMatchObject({ VNC_PASSWORD: expected, NOVNC_PORT: "6099" });
    expect(result).toMatchObject({
      vncAccess: { url: "https://6099-e2b-id.e2b.app", password: expected },
      tunnelUrls: { "3000": "https://3000-e2b-id.e2b.app" },
    });
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

  it("maps bitbucket to the Bitbucket clone identity", async () => {
    // E2B historically collapsed bitbucket to the GitHub identity (a
    // pre-Bitbucket-support drift that made bitbucket clones impossible);
    // it now resolves the real Bitbucket identity like every provider.
    const client = mockClient();
    const provider = new E2BSandboxProvider(client, {
      ...providerConfig,
      scmProvider: "bitbucket",
    });

    await provider.createSandbox(baseCreateConfig);

    const [, env] = vi.mocked(client.writeSessionEnv).mock.calls[0];
    expect(env.VCS_HOST).toBe("bitbucket.org");
    expect(env.VCS_CLONE_USERNAME).toBe("x-token-auth");
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

  it("returns VNC access after resume", async () => {
    const result = await new E2BSandboxProvider(mockClient(), providerConfig).resumeSandbox({
      providerObjectId: "e2b-id",
      sessionId: "sess",
      sandboxId: "sandbox-logical",
      vncEnabled: true,
    });

    expect(result.vncAccess?.url).toBe("https://6080-e2b-id.e2b.app");
    expect(result.vncAccess?.password).toMatch(/^[A-Za-z0-9]{8}$/);
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

  it("stopSandbox pauses (resumable), not kills, and treats 404/409 as success", async () => {
    const client = mockClient();
    const res = await new E2BSandboxProvider(client, providerConfig).stopSandbox({
      providerObjectId: "x",
      sessionId: "s",
      reason: "idle",
    });
    expect(res.success).toBe(true);
    expect(client.pauseSandbox).toHaveBeenCalledWith("x");
    expect(client.killSandbox).not.toHaveBeenCalled();

    for (const err of [new E2BNotFoundError("gone"), new E2BConflictError("already paused")]) {
      const c = mockClient({
        pauseSandbox: vi.fn(async () => {
          throw err;
        }),
      });
      expect(
        (
          await new E2BSandboxProvider(c, providerConfig).stopSandbox({
            providerObjectId: "x",
            sessionId: "s",
            reason: "idle",
          })
        ).success
      ).toBe(true);
    }
  });

  it.each(["connecting_timeout", "respawn"])(
    "stopSandbox KILLS on terminal reason %s",
    async (reason) => {
      const client = mockClient();
      const res = await new E2BSandboxProvider(client, providerConfig).stopSandbox({
        providerObjectId: "x",
        sessionId: "s",
        reason,
      });
      expect(res.success).toBe(true);
      expect(client.killSandbox).toHaveBeenCalledWith("x");
      expect(client.pauseSandbox).not.toHaveBeenCalled();
    }
  );

  it("forwards the caller signal when killing a replaced sandbox", async () => {
    const client = mockClient();
    const signal = AbortSignal.timeout(1_000);

    await new E2BSandboxProvider(client, providerConfig).stopSandbox({
      providerObjectId: "x",
      sessionId: "s",
      reason: "respawn",
      signal,
    });

    expect(client.killSandbox).toHaveBeenCalledWith("x", signal);
  });

  it("resumeSandbox: 404 during connect (post-GET race) returns shouldSpawnFresh", async () => {
    const client = mockClient({
      getSandbox: vi.fn(async () => ({ sandboxID: "e2b-id", templateID: "tmpl", state: "paused" })),
      connectSandbox: vi.fn(async () => {
        throw new E2BNotFoundError("vanished mid-resume");
      }),
    });
    const result = await new E2BSandboxProvider(client, providerConfig).resumeSandbox({
      providerObjectId: "e2b-id",
      sessionId: "sess",
      sandboxId: "sandbox-logical",
    });
    expect(result.success).toBe(false);
    expect(result.shouldSpawnFresh).toBe(true);
  });

  it("honors config.timeoutSeconds on create and resume (child sandboxes)", async () => {
    const client = mockClient();
    const provider = new E2BSandboxProvider(client, providerConfig);

    await provider.createSandbox({ ...baseCreateConfig, timeoutSeconds: 3600 });
    expect(client.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutSeconds: 3600 })
    );

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
    expect(client.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutSeconds: 1800 })
    );
    expect(client.writeSessionEnv).toHaveBeenCalledWith(
      "e2b-id",
      expect.objectContaining({ SANDBOX_TIMEOUT_SECONDS: "1800" }),
      expect.any(Object)
    );
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
        envdAccessToken: "envd-token",
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

  it("creates with secure envd + autoPause, but NOT provider auto-resume", async () => {
    const client = mockClient();
    await new E2BSandboxProvider(client, providerConfig).createSandbox(baseCreateConfig);
    expect(client.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ secure: true, autoPause: true, autoResume: false })
    );
    // secure create returns the token; it must be threaded to the env upload
    const [, , opts] = vi.mocked(client.writeSessionEnv).mock.calls[0];
    expect(opts).toMatchObject({ envdAccessToken: "envd-token" });
  });

  it("fails closed (kills the sandbox, no env write) when create returns no envd token", async () => {
    const client = mockClient({
      createSandbox: vi.fn(async () => ({ sandboxID: "e2b-id", templateID: "tmpl" })),
    });
    const provider = new E2BSandboxProvider(client, providerConfig);
    await expect(provider.createSandbox(baseCreateConfig)).rejects.toMatchObject({
      errorType: "permanent",
      message: expect.stringMatching(/envd access token/),
    });
    expect(client.writeSessionEnv).not.toHaveBeenCalled();
    expect(client.killSandbox).toHaveBeenCalledWith("e2b-id");
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

  it("resumeSandbox running extends the TTL via setSandboxTimeout", async () => {
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
      timeoutSeconds: 7200,
    });
    expect(client.setSandboxTimeout).toHaveBeenCalledWith("e2b-id", 7200);
  });
});

describe("E2BSandboxProvider prebuilt images / snapshots", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps session snapshot/restore off in favour of provider-managed resume", () => {
    const provider = new E2BSandboxProvider(mockClient(), providerConfig);
    // E2B stop/resume already carries a session across idle, and it wins in
    // evaluateSpawnDecision anyway. A snapshot pair here would be a second,
    // unreachable mechanism that leaks a durable TTL-less template per turn.
    expect(provider.capabilities.supportsPersistentResume).toBe(true);
    expect(provider.capabilities.supportsSnapshots).toBe(false);
    expect(provider.capabilities.supportsRestore).toBe(false);
    expect("takeSnapshot" in provider).toBe(false);
    expect("restoreFromSnapshot" in provider).toBe(false);
  });

  it("reports a runtime version at or above the image-selection floor", () => {
    // A version below the floor makes evaluateImageBuildForSpawn reject every
    // image this provider builds (runtime_below_floor), silently disabling
    // prebuilt images. Mirrors the Vercel assertion.
    const version = parseRuntimeVersionNumber(E2B_SANDBOX_VERSION);

    expect(version).not.toBeNull();
    expect(version).toBeGreaterThanOrEqual(MIN_COMPATIBLE_RUNTIME_VERSION);
  });

  it("createSandbox with no prebuilt image uses the base template and no repo-image markers", async () => {
    const client = mockClient();
    await new E2BSandboxProvider(client, providerConfig).createSandbox(baseCreateConfig);
    expect(client.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ templateID: "tmpl" })
    );
    const [, env] = vi.mocked(client.writeSessionEnv).mock.calls[0];
    expect(env).not.toHaveProperty("FROM_REPO_IMAGE");
    expect(env).not.toHaveProperty("REPO_IMAGE_SHA");
  });

  it("createSandbox with a prebuilt image spawns from it and marks the boot", async () => {
    const client = mockClient();
    await new E2BSandboxProvider(client, providerConfig).createSandbox({
      ...baseCreateConfig,
      prebuiltImageId: "snap-repo:default",
      prebuiltImageSha: "abc123",
    });
    // The snapshot id is passed verbatim as the E2B templateID.
    expect(client.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ templateID: "snap-repo:default" })
    );
    const [, env] = vi.mocked(client.writeSessionEnv).mock.calls[0];
    expect(env.FROM_REPO_IMAGE).toBe("true");
    expect(env.REPO_IMAGE_SHA).toBe("abc123");
  });

  it("starts the launcher on a prebuilt boot, after the env is on disk", async () => {
    const client = mockClient();
    await new E2BSandboxProvider(client, providerConfig).createSandbox({
      ...baseCreateConfig,
      prebuiltImageId: "snap-repo:default",
    });
    // A prebuilt image resumes quiet (its bake pause dropped all process memory,
    // and a snapshot resume never re-runs the template start command), so the
    // control plane must start oi-launch itself or nothing consumes the env and
    // the session dies on the connecting timeout with no runtime logs.
    expect(client.startProcess).toHaveBeenCalledWith(
      "e2b-id",
      expect.stringContaining("oi-launch"),
      expect.objectContaining({ envdAccessToken: "envd-token" })
    );
    // The command exits 0 only once the launcher has consumed the session env
    // (launcher-owned liveness evidence — a detached launcher that dies
    // instantly must fail the create, not surface as a silent timeout).
    const [, command] = vi.mocked(client.startProcess).mock.calls[0];
    expect(command).toContain("/tmp/oi-session.env");
    expect(command).toContain("exit 1");
    // Env first, so the launcher consumes the file on its first poll.
    const writeOrder = vi.mocked(client.writeSessionEnv).mock.invocationCallOrder[0];
    const launchOrder = vi.mocked(client.startProcess).mock.invocationCallOrder[0];
    expect(writeOrder).toBeLessThan(launchOrder);
  });

  it("does not start a launcher on a base-template boot", async () => {
    const client = mockClient();
    await new E2BSandboxProvider(client, providerConfig).createSandbox(baseCreateConfig);
    // Base templates resume the launcher E2B captured at template build;
    // starting a second one would race it for the env file.
    expect(client.startProcess).not.toHaveBeenCalled();
  });

  it("kills the sandbox and fails the create when the launcher cannot start", async () => {
    const client = mockClient({
      startProcess: vi.fn(async () => {
        throw new Error("envd process start exited non-zero: exit status 127");
      }),
    });
    await expect(
      new E2BSandboxProvider(client, providerConfig).createSandbox({
        ...baseCreateConfig,
        prebuiltImageId: "snap-repo:default",
      })
    ).rejects.toThrow(/Failed to create E2B sandbox/);
    // Without the kill the sandbox idles unbootable until its TTL.
    expect(client.killSandbox).toHaveBeenCalledWith("e2b-id");
  });

  it("takePrebuiltImageSnapshot sanitizes via pause(memory:false)+connect before snapshot", async () => {
    const client = mockClient();
    const provider = new E2BSandboxProvider(client, providerConfig);
    const result = await provider.takePrebuiltImageSnapshot({
      providerObjectId: "build-sbx",
      sessionId: "build-1",
      reason: "environment_image_build",
    });
    expect(client.pauseSandbox).toHaveBeenCalledWith("build-sbx", { memory: false }, undefined);
    expect(client.connectSandbox).toHaveBeenCalledWith("build-sbx", expect.any(Number), undefined);
    expect(client.createSnapshot).toHaveBeenCalledWith("build-sbx", { signal: undefined });
    // The image's contract is its filesystem: the bake starts nothing inside the
    // sandbox, and every spawn from the image starts the launcher itself. Baking
    // a waiting launcher in would make bootability depend on captured memory.
    expect(client.startProcess).not.toHaveBeenCalled();
    const pauseOrder = vi.mocked(client.pauseSandbox).mock.invocationCallOrder[0];
    const connectOrder = vi.mocked(client.connectSandbox).mock.invocationCallOrder[0];
    const snapOrder = vi.mocked(client.createSnapshot).mock.invocationCallOrder[0];
    expect(pauseOrder).toBeLessThan(connectOrder);
    expect(connectOrder).toBeLessThan(snapOrder);
    expect(result).toEqual({ success: true, imageId: "snap-abc:default" });
  });

  it("takePrebuiltImageSnapshot forwards the caller deadline to every step", async () => {
    const client = mockClient();
    const signal = AbortSignal.timeout(60_000);
    await new E2BSandboxProvider(client, providerConfig).takePrebuiltImageSnapshot({
      providerObjectId: "build-sbx",
      sessionId: "build-1",
      reason: "environment_image_build",
      signal,
    });
    expect(client.pauseSandbox).toHaveBeenCalledWith("build-sbx", { memory: false }, signal);
    expect(client.connectSandbox).toHaveBeenCalledWith("build-sbx", expect.any(Number), signal);
    expect(client.createSnapshot).toHaveBeenCalledWith("build-sbx", { signal });
  });

  it("takePrebuiltImageSnapshot fails when the API returns no snapshot id", async () => {
    const client = mockClient({
      createSnapshot: vi.fn(async () => ({ snapshotID: "", names: [] })),
    });
    const result = await new E2BSandboxProvider(client, providerConfig).takePrebuiltImageSnapshot({
      providerObjectId: "build-sbx",
      sessionId: "build-1",
      reason: "environment_image_build",
    });
    expect(result.success).toBe(false);
  });

  it("deleteProviderImage deletes the snapshot template and swallows a 404", async () => {
    const client = mockClient();
    await new E2BSandboxProvider(client, providerConfig).deleteProviderImage("snap-x:default");
    expect(client.deleteTemplate).toHaveBeenCalledWith("snap-x:default", undefined);

    const gone = mockClient({
      deleteTemplate: vi.fn(async () => {
        throw new E2BNotFoundError("already gone");
      }),
    });
    await expect(
      new E2BSandboxProvider(gone, providerConfig).deleteProviderImage("snap-x:default")
    ).resolves.toBeUndefined();
  });

  it("deleteSandbox kills the build sandbox and swallows a 404", async () => {
    const client = mockClient();
    await new E2BSandboxProvider(client, providerConfig).deleteSandbox("build-sbx");
    expect(client.killSandbox).toHaveBeenCalledWith("build-sbx", undefined);

    const gone = mockClient({
      killSandbox: vi.fn(async () => {
        throw new E2BNotFoundError("already gone");
      }),
    });
    await expect(
      new E2BSandboxProvider(gone, providerConfig).deleteSandbox("build-sbx")
    ).resolves.toBeUndefined();
  });

  it("triggerImageBuild boots a non-pausing build sandbox with build-mode env", async () => {
    const client = mockClient();
    const onProviderSessionCreated = vi.fn(async () => {});
    await new E2BSandboxProvider(client, providerConfig).triggerImageBuild({
      buildId: "build-1",
      scopeKind: "environment",
      scopeId: "env-1",
      repositories: [
        { repoOwner: "o", repoName: "r", baseBranch: "main" },
        { repoOwner: "o2", repoName: "r2", baseBranch: "dev" },
      ],
      callbackUrl: "https://cp.test/cb",
      failureCallbackUrl: "https://cp.test/cb/fail",
      callbackToken: "cb-token",
      cloneToken: "clone-token",
      buildExecutionTimeoutSeconds: 1800,
      providerSessionTimeoutSeconds: 2100,
      onProviderSessionCreated,
      correlation: { request_id: "request-1", trace_id: "trace-1" },
    });

    // Build sandbox uses the base template and must not auto-pause (it idles
    // awaiting the snapshot), and lives for the adapter-resolved session budget.
    expect(client.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        templateID: "tmpl",
        autoPause: false,
        secure: true,
        timeoutSeconds: 2100,
      })
    );

    // The provider session is bound (with the real sandbox id) before env delivery.
    expect(onProviderSessionCreated).toHaveBeenCalledWith("e2b-id");
    const bindOrder = onProviderSessionCreated.mock.invocationCallOrder[0];
    const writeOrder = vi.mocked(client.writeSessionEnv).mock.invocationCallOrder[0];
    expect(bindOrder).toBeLessThan(writeOrder);

    const [, env] = vi.mocked(client.writeSessionEnv).mock.calls[0];
    expect(env.IMAGE_BUILD_MODE).toBe("true");
    expect(env.SANDBOX_VERSION).toMatch(/^v\d+/);
    expect(env.OI_REPO_IMAGE_PROVIDER_SESSION_ID).toBe("e2b-id");
    expect(env.OI_REPO_IMAGE_BUILD_ID).toBe("build-1");
    expect(env.OI_REPO_IMAGE_CALLBACK_URL).toBe("https://cp.test/cb");
    expect(env.OI_REPO_IMAGE_FAILURE_CALLBACK_URL).toBe("https://cp.test/cb/fail");
    expect(env.OI_REPO_IMAGE_CALLBACK_TOKEN).toBe("cb-token");
    expect(env.OI_IMAGE_BUILD_EXECUTION_TIMEOUT_SECONDS).toBe("1800");
    expect(env.VCS_CLONE_TOKEN).toBe("clone-token");
    const sessionConfig = JSON.parse(env.SESSION_CONFIG);
    expect(sessionConfig.repositories).toHaveLength(2);
  });

  it("triggerImageBuild kills the sandbox if binding the session fails", async () => {
    const client = mockClient();
    const provider = new E2BSandboxProvider(client, providerConfig);
    await expect(
      provider.triggerImageBuild({
        buildId: "build-1",
        scopeKind: "environment",
        scopeId: "env-1",
        repositories: [{ repoOwner: "o", repoName: "r", baseBranch: "main" }],
        callbackUrl: "https://cp.test/cb",
        failureCallbackUrl: "https://cp.test/cb/fail",
        callbackToken: "cb-token",
        buildExecutionTimeoutSeconds: 1800,
        providerSessionTimeoutSeconds: 2100,
        onProviderSessionCreated: vi.fn(async () => {
          throw new Error("bind failed");
        }),
        correlation: { request_id: "request-1", trace_id: "trace-1" },
      })
    ).rejects.toBeInstanceOf(SandboxProviderError);
    expect(client.killSandbox).toHaveBeenCalledWith("e2b-id");
    expect(client.writeSessionEnv).not.toHaveBeenCalled();
  });
});
