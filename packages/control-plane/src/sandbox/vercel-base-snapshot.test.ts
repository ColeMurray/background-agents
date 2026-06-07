import { describe, expect, it, vi } from "vitest";
import { buildBaseSnapshotSandboxName, buildVercelBaseSnapshot } from "./vercel-base-snapshot";
import type {
  VercelCreateSandboxResponse,
  VercelRunCommandRequest,
  VercelSandboxClient,
  VercelSnapshotResponse,
  VercelWriteFileArchiveRequest,
} from "./vercel-client";

function createSessionResponse(sessionId = "session-1"): VercelCreateSandboxResponse {
  return {
    sandbox: {
      name: "base-build",
      currentSessionId: sessionId,
      createdAt: 123,
      status: "running",
    },
    session: {
      id: sessionId,
      status: "running",
      createdAt: 123,
      cwd: "/workspace",
      timeout: 1800000,
    },
    routes: [],
  };
}

function createMockClient(
  overrides: Partial<{
    createSandbox: () => Promise<VercelCreateSandboxResponse>;
    runCommandAndWait: (
      request: VercelRunCommandRequest
    ) => Promise<{ commandId: string; exitCode: number | null }>;
    writeFileArchive: (request: VercelWriteFileArchiveRequest) => Promise<void>;
    snapshotSession: (sessionId: string) => Promise<VercelSnapshotResponse>;
    stopSession: (sessionId: string) => Promise<void>;
  }> = {}
): VercelSandboxClient {
  return {
    createSandbox: vi.fn(async () => createSessionResponse()),
    runCommandAndWait: vi.fn(async () => ({ commandId: "cmd-1", exitCode: 0 })),
    writeFileArchive: vi.fn(async () => {}),
    snapshotSession: vi.fn(
      async (): Promise<VercelSnapshotResponse> => ({
        snapshot: { id: "snap-base-1", status: "created", createdAt: 456 },
        session: createSessionResponse().session,
      })
    ),
    stopSession: vi.fn(async () => {}),
    ...overrides,
  } as unknown as VercelSandboxClient;
}

describe("buildVercelBaseSnapshot", () => {
  it("bootstraps, snapshots, and stops a temporary Vercel sandbox", async () => {
    const client = createMockClient();

    const result = await buildVercelBaseSnapshot(client, {
      runtime: "node24",
      runtimeArchive: new Uint8Array([1, 2, 3]),
      sourceVersion: "abcdef1234567890",
      sandboxName: "openinspect-base-managed",
      now: 1780000000000,
    });

    expect(vi.mocked(client.createSandbox)).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "openinspect-base-managed",
        runtime: "node24",
        timeoutMs: 30 * 60 * 1000,
        ports: [],
        tags: expect.objectContaining({
          openinspect_framework: "open-inspect",
          openinspect_kind: "base-runtime-build",
          openinspect_runtime_source: "local-checkout",
          openinspect_runtime_ref: "abcdef1234567890",
          openinspect_source_version: "abcdef1234567890",
        }),
      }),
      undefined
    );
    expect(vi.mocked(client.writeFileArchive)).toHaveBeenCalledWith(
      {
        sessionId: "session-1",
        archive: new Uint8Array([1, 2, 3]),
        extractDir: "/tmp/open-inspect-runtime/packages",
      },
      undefined
    );
    expect(vi.mocked(client.runCommandAndWait)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        command: "bash",
        args: [
          "-lc",
          "rm -rf '/tmp/open-inspect-runtime' && mkdir -p '/tmp/open-inspect-runtime/packages'",
        ],
        timeoutMs: 30_000,
      }),
      undefined
    );
    expect(vi.mocked(client.runCommandAndWait)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        command: "bash",
        args: ["-lc", expect.stringContaining("/tmp/open-inspect-runtime/packages")],
        timeoutMs: 20 * 60 * 1000,
      }),
      undefined
    );
    expect(vi.mocked(client.snapshotSession)).toHaveBeenCalledWith(
      "session-1",
      { expirationMs: 0 },
      undefined
    );
    expect(vi.mocked(client.stopSession)).toHaveBeenCalledWith("session-1", undefined);
    expect(result).toEqual({
      snapshotId: "snap-base-1",
      sandboxName: "openinspect-base-managed",
      sessionId: "session-1",
    });
  });

  it("stops the temporary sandbox when bootstrap fails", async () => {
    const client = createMockClient({
      runCommandAndWait: vi
        .fn()
        .mockResolvedValueOnce({ commandId: "cmd-1", exitCode: 0 })
        .mockResolvedValueOnce({ commandId: "cmd-2", exitCode: 1 }),
    });

    await expect(
      buildVercelBaseSnapshot(client, { runtimeArchive: new Uint8Array([1]) })
    ).rejects.toThrow("Vercel base runtime bootstrap failed");
    expect(vi.mocked(client.stopSession)).toHaveBeenCalledWith("session-1", undefined);
    expect(vi.mocked(client.snapshotSession)).not.toHaveBeenCalled();
  });
});

describe("buildBaseSnapshotSandboxName", () => {
  it("normalizes dynamic build names", () => {
    expect(
      buildBaseSnapshotSandboxName({
        prefix: "Open Inspect Base",
        sourceVersion: "Feature/ABC_def-1234567890",
        now: 1780000000000,
      })
    ).toBe("open-inspect-base-feature-abc-1780000000000");
  });
});
