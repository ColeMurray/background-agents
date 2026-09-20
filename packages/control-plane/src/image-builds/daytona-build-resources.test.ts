/**
 * Unit tests for DaytonaImageBuildResources.
 *
 * Tests the source sandbox an image build runs in and the snapshot captured
 * from it: the dormant create, the stdin launch, ownership-verified deletes,
 * and the polls that observe each of those to completion.
 */

import { webcrypto } from "node:crypto";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  DaytonaImageBuildResources,
  type DaytonaImageBuildResourcesConfig,
} from "./daytona-build-resources";
import {
  DaytonaNotFoundError,
  DaytonaApiError,
  type DaytonaRestClient,
  type DaytonaSandboxResponse,
  type DaytonaCreateSandboxParams,
  type DaytonaToolboxTarget,
  type DaytonaRestConfig,
} from "../sandbox/daytona-rest-client";

const defaultRestConfig: DaytonaRestConfig = {
  apiUrl: "https://daytona.test/api",
  apiKey: "test-api-key",
  baseSnapshot: "base-snapshot-v1",
  autoStopIntervalMinutes: 120,
  autoArchiveIntervalMinutes: 10080,
};

const defaultResourcesConfig: DaytonaImageBuildResourcesConfig = { scmProvider: "github" };

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

function buildResources(client: ReturnType<typeof createBuildClient>) {
  return new DaytonaImageBuildResources(
    client as unknown as DaytonaRestClient,
    defaultResourcesConfig
  );
}

/** Longer than any single lifecycle budget these flows wait out. */
const PROVIDER_TEST_CLOCK_MS = 180_000;
const TEST_CLOCK_SLICES = 40;

/**
 * Drive a call that paces itself to completion. Every lifecycle flow
 * polls, so the test clock — not wall time — is what these assertions run on.
 *
 * The clock is advanced in slices until the call settles, because a flow
 * arms its next wait only after asynchronous provider work completes: a
 * single advance can finish before the timer it was meant to fire exists.
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
describe("DaytonaImageBuildResources", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Resource-name hashing is covered by daytona-rest-client.test.ts. Keep
    // these lifecycle tests independent of WebCrypto worker scheduling so a
    // loaded CI runner cannot strand the fake-clock driver behind a digest.
    vi.spyOn(webcrypto.subtle, "digest").mockResolvedValue(new Uint8Array(32).buffer);
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

    await complete(buildResources(client).triggerImageBuild(config));

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

    await complete(buildResources(client).triggerImageBuild(config));

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
      buildResources(client).triggerImageBuild(buildTriggerConfig({ cloneToken: undefined }))
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
  ])("leaves failure cleanup to the workflow when %s fails", async (_name, failing) => {
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

    await expect(complete(buildResources(client).triggerImageBuild(config))).rejects.toThrow();

    expect(client.deleteSandbox).not.toHaveBeenCalled();
  });

  it("fails the trigger when the launcher has already refused its context", async () => {
    const client = createBuildClient({
      getSessionCommand: vi.fn(async () => ({ id: "cmd-1", exitCode: 1 })),
    });

    await expect(
      complete(buildResources(client).triggerImageBuild(buildTriggerConfig()))
    ).rejects.toThrow(/exited 1/);
    expect(client.deleteSandbox).not.toHaveBeenCalled();
  });

  it("refuses to bind a provider id it would not address safely", async () => {
    const client = createBuildClient({
      createSandbox: vi.fn(async () => ({ id: "sandbox id/../etc", state: "creating" })),
    });
    const config = buildTriggerConfig();

    await expect(complete(buildResources(client).triggerImageBuild(config))).rejects.toThrow(
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
      complete(buildResources(stopped).stopBuildSandboxForCapture("daytona-build-1"))
    ).resolves.toBe("stopped");
    expect(stopped.stopSandbox).toHaveBeenCalledWith("daytona-build-1", undefined);

    const alreadyStopped = createBuildClient({
      getSandbox: vi.fn(async () => ({ id: "daytona-build-1", state: "stopped", labels: {} })),
    });
    await expect(
      complete(buildResources(alreadyStopped).stopBuildSandboxForCapture("daytona-build-1"))
    ).resolves.toBe("stopped");
    expect(alreadyStopped.stopSandbox).not.toHaveBeenCalled();
  });

  it("refuses to capture a source that reached a terminal state", async () => {
    const client = createBuildClient({
      getSandbox: vi.fn(async () => ({ id: "daytona-build-1", state: "error", labels: {} })),
    });

    await expect(
      complete(buildResources(client).stopBuildSandboxForCapture("daytona-build-1"))
    ).rejects.toThrow(/can no longer be captured/);
  });

  it("treats a capture name that already exists as accepted", async () => {
    const client = createBuildClient({
      createSandboxSnapshot: vi.fn(async () => {
        throw new DaytonaApiError("snapshot name already exists", 409);
      }),
    });

    await expect(
      complete(buildResources(client).captureBuildSnapshot("daytona-build-1", "oi-image-abc"))
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
      complete(buildResources(client).deleteBuildSandbox("daytona-build-1", BUILD_ID))
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
      complete(buildResources(client).deleteBuildSandbox("daytona-build-1", BUILD_ID))
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

      const deleting = buildResources(client)
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
      complete(buildResources(mine).findBuildSandboxByName(BUILD_ID))
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
      complete(buildResources(theirs).findBuildSandboxByName(BUILD_ID))
    ).resolves.toBeNull();

    const absent = createBuildClient({
      getSandbox: vi.fn(async () => {
        throw new DaytonaNotFoundError("gone");
      }),
    });
    await expect(
      complete(buildResources(absent).findBuildSandboxByName(BUILD_ID))
    ).resolves.toBeNull();
  });

  it("never deletes the configured base snapshot", async () => {
    const byName = createBuildClient();

    await expect(
      complete(buildResources(byName).deleteProviderImage("base-snapshot-v1"))
    ).rejects.toThrow(/base snapshot/);
    expect(byName.deleteSnapshot).not.toHaveBeenCalled();

    const byId = createBuildClient({
      getSnapshot: vi.fn(async () => ({
        id: "snapshot-1",
        name: "base-snapshot-v1",
        state: "active",
      })),
    });
    await expect(complete(buildResources(byId).deleteProviderImage("snapshot-1"))).rejects.toThrow(
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
      complete(buildResources(client).deleteProviderImage("snapshot-1"))
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

      const deleting = buildResources(client)
        .deleteProviderImage("snapshot-1")
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(await deleting).toMatchObject({ errorType: "transient" });
      expect(client.deleteSnapshot).not.toHaveBeenCalled();
    }
  });
});
