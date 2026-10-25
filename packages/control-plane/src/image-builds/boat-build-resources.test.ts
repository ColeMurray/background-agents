import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  BOAT_LAUNCHER_PATH,
  BOAT_SANDBOX_VERSION,
  boatIdempotencyKey,
} from "../sandbox/boat-lifecycle";
import {
  BOAT_SAVED_SNAPSHOT_NAME_PATTERN,
  BoatApiError,
  BoatNotFoundError,
  type BoatCreateSandboxParams,
} from "../sandbox/boat-rest-client";
import { SandboxProviderError } from "../sandbox/provider";
import {
  boatCreated,
  boatSandbox,
  fastTimings,
  mockClient,
} from "../sandbox/providers/boat-provider.test-helpers";
import {
  BOAT_IMAGE_BUILD_ENV_FILE_PATH,
  BoatImageBuildResources,
  boatImageSnapshotName,
  shellEnvFile,
  type BoatImageBuildResourcesConfig,
} from "./boat-build-resources";

const config: BoatImageBuildResourcesConfig = {
  scmProvider: "github",
  deploymentName: "test",
  defaultMachineType: "default",
  baseSnapshot: "open-inspect-abc123",
};

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

function createResources(
  client = mockClient(),
  overrides: Partial<BoatImageBuildResourcesConfig> = {}
): BoatImageBuildResources {
  return new BoatImageBuildResources(client, { ...config, ...overrides }, fastTimings);
}

/** The env file as the launcher sees it: parsed back from its `export` lines. */
function envFileWritten(client: ReturnType<typeof mockClient>): Record<string, string> {
  const [sandboxId, file] = vi.mocked(client.writeFile).mock.calls[0];
  expect(sandboxId).toBe("bx_abcdefgh");
  expect(file.path).toBe(BOAT_IMAGE_BUILD_ENV_FILE_PATH);
  return Object.fromEntries(
    file.content
      .split(/\n(?=export )/)
      .filter((line) => line.length > 0)
      .map((line) => {
        const match = /^export ([A-Za-z_][A-Za-z0-9_]*)='([\s\S]*)'\n?$/.exec(line);
        if (!match) throw new Error(`unparseable env line: ${line}`);
        return [match[1], match[2].replace(/'\\''/g, "'")];
      })
  );
}

describe("BoatImageBuildResources triggerImageBuild", () => {
  it("creates the sandbox named, private and with the boot markers alone, binds it, delivers the env, then launches", async () => {
    const client = mockClient({
      createSandbox: vi.fn(async (params: BoatCreateSandboxParams) =>
        boatCreated(params, { visibility: "private" })
      ),
    });
    const order: string[] = [];
    vi.mocked(client.getSandbox).mockImplementation(async () => {
      order.push("ready");
      return boatSandbox();
    });
    vi.mocked(client.writeFile).mockImplementation(async () => {
      order.push("env");
    });
    vi.mocked(client.startDetachedCommand).mockImplementation(async () => {
      order.push("launch");
      return { processId: 7 };
    });
    const onProviderSessionCreated = vi.fn(async () => {
      order.push("bind");
    });

    await createResources(client).triggerImageBuild({ ...buildConfig, onProviderSessionCreated });

    const [params] = vi.mocked(client.createSandbox).mock.calls[0];
    expect(params).toMatchObject({
      type: "default",
      ttlSeconds: 2400,
      from: "open-inspect-abc123",
      monitoring: false,
      idempotencyKey: await boatIdempotencyKey("test", buildConfig.buildId, "build-env-acme/repo"),
      // Boat sets both before the sandbox has a machine, so neither needs a
      // call of its own afterwards.
      name: expect.stringMatching(/^openinspect-test-build-env-acme\/repo-\d+$/),
      visibility: "private",
    });
    // Nothing of the build rides the create request: a saved snapshot of
    // this sandbox inherits these markers and nothing else.
    expect(params.env).toEqual({
      IMAGE_BUILD_MODE: "true",
      OI_DEFERRED_START: "false",
      RESTORED_FROM_SNAPSHOT: "false",
      FROM_REPO_IMAGE: "false",
      SANDBOX_VERSION: BOAT_SANDBOX_VERSION,
    });

    expect(order).toEqual(["bind", "ready", "env", "launch"]);
    expect(client.unshareSandbox).not.toHaveBeenCalled();
    expect(onProviderSessionCreated).toHaveBeenCalledWith("bx_abcdefgh");

    const env = envFileWritten(client);
    expect(env).toMatchObject({
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
    expect(JSON.parse(env.SESSION_CONFIG)).toEqual({
      branch: "main",
      repositories: [{ repo_owner: "acme", repo_name: "repo", branch: "main" }],
    });
    // The sandbox id does not exist at create time; it rides the launch instead.
    expect(env).not.toHaveProperty("OI_REPO_IMAGE_PROVIDER_SESSION_ID");
    expect(env).not.toHaveProperty("BOAT_ID");
    expect(env).not.toHaveProperty("SANDBOX_AUTH_TOKEN");
    expect(client.startDetachedCommand).toHaveBeenCalledWith(
      "bx_abcdefgh",
      `OI_REPO_IMAGE_PROVIDER_SESSION_ID=bx_abcdefgh ${BOAT_LAUNCHER_PATH}`
    );
    expect(client.updateSandbox).not.toHaveBeenCalled();
    expect(client.hostPort).not.toHaveBeenCalled();
    expect(client.deleteSandbox).not.toHaveBeenCalled();
  });

  it("sizes the build machine by the scope's resource request", async () => {
    const client = mockClient();
    await createResources(client).triggerImageBuild({
      ...buildConfig,
      resources: { cpuCores: 2, memoryMib: 16384 },
      onProviderSessionCreated: vi.fn(async () => {}),
    });
    expect(vi.mocked(client.createSandbox).mock.calls[0][0].type).toBe("large");

    const unsized = mockClient();
    await createResources(unsized, { defaultMachineType: "small" }).triggerImageBuild({
      ...buildConfig,
      onProviderSessionCreated: vi.fn(async () => {}),
    });
    expect(vi.mocked(unsized.createSandbox).mock.calls[0][0].type).toBe("small");
  });

  it("makes a sandbox the create answered as shared private before binding it", async () => {
    const client = mockClient({
      createSandbox: vi.fn(async (params: BoatCreateSandboxParams) =>
        boatCreated(params, { visibility: "shared" })
      ),
    });
    const order: string[] = [];
    vi.mocked(client.unshareSandbox).mockImplementation(async () => {
      order.push("private");
      return boatSandbox({ visibility: "private" });
    });
    const onProviderSessionCreated = vi.fn(async () => {
      order.push("bind");
    });
    await createResources(client).triggerImageBuild({ ...buildConfig, onProviderSessionCreated });
    expect(order).toEqual(["private", "bind"]);
    expect(client.deleteSandbox).not.toHaveBeenCalled();
  });

  it("deletes a sandbox it cannot make private, before anything is bound or delivered", async () => {
    const client = mockClient({
      createSandbox: vi.fn(async (params: BoatCreateSandboxParams) =>
        boatCreated(params, { visibility: "shared" })
      ),
      unshareSandbox: vi.fn(async () => boatSandbox({ visibility: "shared" })),
    });
    const onProviderSessionCreated = vi.fn(async () => {});
    await expect(
      createResources(client).triggerImageBuild({ ...buildConfig, onProviderSessionCreated })
    ).rejects.toThrow("stayed shared");
    expect(onProviderSessionCreated).not.toHaveBeenCalled();
    expect(client.writeFile).not.toHaveBeenCalled();
    expect(client.startDetachedCommand).not.toHaveBeenCalled();
    expect(client.deleteSandbox).toHaveBeenCalledWith("bx_abcdefgh");
  });

  it("refuses to bind or launch a sandbox id outside the expected alphabet", async () => {
    const client = mockClient({
      createSandbox: vi.fn(async (params: BoatCreateSandboxParams) =>
        boatCreated(params, { id: "bx_abc; rm -rf /", state: "ready" })
      ),
    });
    const onProviderSessionCreated = vi.fn(async () => {});
    await expect(
      createResources(client).triggerImageBuild({ ...buildConfig, onProviderSessionCreated })
    ).rejects.toThrow("expected alphabet");
    expect(onProviderSessionCreated).not.toHaveBeenCalled();
    expect(client.startDetachedCommand).not.toHaveBeenCalled();
    expect(client.deleteSandbox).toHaveBeenCalledWith("bx_abc; rm -rf /");
  });

  it("leaves a sandbox it has handed to the workflow alone when a later step fails", async () => {
    // A rejected bind: the workflow already holds the id for cleanup.
    const bind = mockClient();
    const bindError = await createResources(bind)
      .triggerImageBuild({
        ...buildConfig,
        onProviderSessionCreated: vi.fn(async () => {
          throw new Error("bind failed");
        }),
      })
      .catch((e: unknown) => e);
    expect(bindError).toBeInstanceOf(SandboxProviderError);
    expect((bindError as Error).message).toContain("bind failed");
    expect(bind.startDetachedCommand).not.toHaveBeenCalled();
    expect(bind.deleteSandbox).not.toHaveBeenCalled();

    // A lost env delivery: the launch never happens, and the bound source is
    // the workflow's to arbitrate.
    const delivery = mockClient({
      writeFile: vi.fn(async () => {
        throw new BoatApiError("gateway", 502);
      }),
    });
    await expect(
      createResources(delivery).triggerImageBuild({
        ...buildConfig,
        onProviderSessionCreated: vi.fn(async () => {}),
      })
    ).rejects.toMatchObject({ errorType: "transient" });
    expect(delivery.startDetachedCommand).not.toHaveBeenCalled();
    expect(delivery.deleteSandbox).not.toHaveBeenCalled();

    // An early launcher exit after the bind: a fast build may already have
    // reported completion, so the source is never deleted from here.
    const launch = mockClient({
      getCommandStatus: vi.fn(async () => ({
        status: "exited" as const,
        running: false,
        exitCode: 1,
        stdout: "",
        stderr: "toolchain missing",
      })),
    });
    await expect(
      createResources(launch).triggerImageBuild({
        ...buildConfig,
        onProviderSessionCreated: vi.fn(async () => {}),
      })
    ).rejects.toThrow("exited with code 1");
    expect(launch.deleteSandbox).not.toHaveBeenCalled();
  });

  it("cannot start without the base snapshot", async () => {
    const client = mockClient();
    await expect(
      createResources(client, { baseSnapshot: undefined }).triggerImageBuild({
        ...buildConfig,
        onProviderSessionCreated: vi.fn(async () => {}),
      })
    ).rejects.toThrow("BOAT_BASE_SNAPSHOT is required to start a Boat image build");
    expect(client.createSandbox).not.toHaveBeenCalled();
  });
});

describe("BoatImageBuildResources stopBuildSandboxForSave", () => {
  it("archives a live source and reports it stopped", async () => {
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
    const signal = AbortSignal.timeout(60_000);
    await expect(
      createResources(client).stopBuildSandboxForSave("bx_abcdefgh", signal)
    ).resolves.toBe("stopped");
    expect(client.stopSandbox).toHaveBeenCalledWith("bx_abcdefgh", expect.any(AbortSignal));
  });

  it("does not stop a source that is already archived with a snapshot", async () => {
    const client = mockClient({
      getSandbox: vi.fn(async () => boatSandbox({ state: "archived", snapshotAvailable: true })),
    });
    await expect(createResources(client).stopBuildSandboxForSave("bx_abcdefgh")).resolves.toBe(
      "stopped"
    );
    expect(client.stopSandbox).not.toHaveBeenCalled();
  });

  it("reports a missing source, and an archive that outlasts the budget as still stopping", async () => {
    const missing = mockClient({
      getSandbox: vi.fn(async () => {
        throw new BoatNotFoundError("gone");
      }),
    });
    await expect(createResources(missing).stopBuildSandboxForSave("bx_abcdefgh")).resolves.toBe(
      "missing"
    );

    const slow = mockClient({
      getSandbox: vi.fn(async () =>
        boatSandbox({ state: "archiving", stop: { id: "stop_1", status: "pending" } })
      ),
    });
    await expect(createResources(slow).stopBuildSandboxForSave("bx_abcdefgh")).resolves.toBe(
      "stopping"
    );
    // The caller's own budget ending is the same answer: Boat is still archiving.
    await expect(
      createResources(slow).stopBuildSandboxForSave("bx_abcdefgh", AbortSignal.abort())
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
    const error = await createResources(client)
      .stopBuildSandboxForSave("bx_abcdefgh")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxProviderError);
    expect((error as SandboxProviderError).errorType).toBe("permanent");
    expect((error as Error).message).toContain("disk busy");
  });

  it("does not take a stale automatic snapshot behind a failed stop for a usable archive", async () => {
    const client = mockClient({
      getSandbox: vi.fn(async () =>
        boatSandbox({
          state: "archived",
          snapshotAvailable: true,
          stop: { id: "stop_1", status: "failing", error: "capture failed" },
        })
      ),
    });
    const error = await createResources(client)
      .stopBuildSandboxForSave("bx_abcdefgh")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxProviderError);
    expect((error as SandboxProviderError).errorType).toBe("permanent");
    expect((error as Error).message).toContain("capture failed");
  });

  it("lets a Boat refusal through untouched for the adapter to weigh", async () => {
    const client = mockClient({
      getSandbox: vi.fn(async () => {
        throw new BoatApiError("busy", 503);
      }),
    });
    await expect(
      createResources(client).stopBuildSandboxForSave("bx_abcdefgh")
    ).rejects.toBeInstanceOf(BoatApiError);
  });
});

describe("BoatImageBuildResources image snapshots", () => {
  it("saves, reads and deletes image snapshots and build sandboxes through the client", async () => {
    const client = mockClient();
    const resources = createResources(client);
    const signal = AbortSignal.timeout(60_000);
    await expect(
      resources.saveImageSnapshot("bx_abcdefgh", "oi-img-x", signal)
    ).resolves.toMatchObject({ status: "saving" });
    expect(client.saveSavedSnapshot).toHaveBeenCalledWith("bx_abcdefgh", "oi-img-x", signal);
    await expect(resources.getImageSnapshot("oi-img-x")).resolves.toMatchObject({
      name: "oi-img-x",
    });
    vi.mocked(client.getSavedSnapshot).mockRejectedValueOnce(new BoatNotFoundError("gone"));
    await expect(resources.getImageSnapshot("oi-img-gone")).resolves.toBeNull();
    await resources.deleteProviderImage("oi-img-x", signal);
    expect(client.deleteSavedSnapshot).toHaveBeenCalledWith("oi-img-x", signal);
    vi.mocked(client.deleteSavedSnapshot).mockRejectedValueOnce(new BoatNotFoundError("gone"));
    await expect(resources.deleteProviderImage("oi-img-gone")).resolves.toBeUndefined();
    await resources.deleteBuildSandbox("bx_abcdefgh", signal);
    expect(client.deleteSandbox).toHaveBeenCalledWith("bx_abcdefgh", signal);
    vi.mocked(client.deleteSandbox).mockRejectedValueOnce(new BoatNotFoundError("gone"));
    await expect(resources.deleteBuildSandbox("bx_gone")).resolves.toBeUndefined();
  });

  it("keeps Boat's code on a refused save, and refuses to delete the base snapshot", async () => {
    const client = mockClient({
      saveSavedSnapshot: vi.fn(async () => {
        throw new BoatApiError("credit", 402, "credit_required");
      }),
    });
    const resources = createResources(client);
    const error = await resources.saveImageSnapshot("bx_abcdefgh", "oi-img-x").catch((e) => e);
    expect(error).toBeInstanceOf(BoatApiError);
    expect((error as BoatApiError).code).toBe("credit_required");

    await expect(resources.deleteProviderImage("open-inspect-abc123")).rejects.toThrow(
      "Refusing to delete the configured Boat base snapshot"
    );
    expect(client.deleteSavedSnapshot).not.toHaveBeenCalled();
  });

  it("derives the image name for the deployment", async () => {
    await expect(
      createResources().imageSnapshotName("imgb-acme-repo-1757000000000-ab12")
    ).resolves.toBe(await boatImageSnapshotName("test", "imgb-acme-repo-1757000000000-ab12"));
  });
});

describe("boatImageSnapshotName", () => {
  it("is a valid Boat name that leads with the build's scope and ends with a deployment digest", async () => {
    const name = await boatImageSnapshotName("prod", "imgb-acme-repo-1757000000000-ab12");
    expect(name).toMatch(BOAT_SAVED_SNAPSHOT_NAME_PATTERN);
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
    expect(name).toMatch(BOAT_SAVED_SNAPSHOT_NAME_PATTERN);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/^oi-img-group-sub-group-a-very-long-[0-9a-f]{16}$/);
  });
});

describe("shellEnvFile", () => {
  it("writes values a shell reads back literally, whatever they contain", () => {
    const env = {
      PLAIN: "bar",
      QUOTED: `it's "quoted" and 'single'`,
      SHELLY: "$HOME `whoami` $(id) \\n \\",
      MULTILINE: "line one\nline two\n",
      EMPTY: "",
    };
    const content = shellEnvFile(env);
    expect(content.startsWith("export PLAIN='bar'\n")).toBe(true);

    const script = `${content}printf '%s\\0' "$PLAIN" "$QUOTED" "$SHELLY" "$MULTILINE" "$EMPTY"`;
    const readBack = execFileSync("bash", ["-c", script], { encoding: "utf8" }).split("\0");
    expect(readBack.slice(0, 5)).toEqual([
      env.PLAIN,
      env.QUOTED,
      env.SHELLY,
      env.MULTILINE,
      env.EMPTY,
    ]);
  });
});
