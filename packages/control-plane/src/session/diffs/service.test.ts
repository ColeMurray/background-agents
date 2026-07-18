import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../logger";
import type { SessionMessenger } from "../messenger";
import type { SessionRepository } from "../repository";
import type { SqlResult, SqlStorage } from "../sql-storage";
import { SessionDiffService } from "./service";
import { SessionDiffStore } from "./store";

class MemoryDiffSql implements SqlStorage {
  row: Record<string, unknown> | null = null;

  exec(query: string, ...params: unknown[]): SqlResult {
    if (query.includes("SELECT * FROM session_diff"))
      return this.result(this.row ? [this.row] : []);
    if (query.includes("bundle_json")) {
      this.row = {
        singleton: 1,
        revision_id: params[0],
        trigger_message_id: params[1],
        bundle_json: params[2],
        captured_at: params[3],
        last_error: null,
        error_at: null,
        updated_at: params[4],
      };
      return this.result([], 1);
    }
    if (query.includes("last_error")) {
      this.row = {
        revision_id: null,
        trigger_message_id: null,
        bundle_json: null,
        captured_at: null,
        ...this.row,
        last_error: params[0],
        error_at: params[1],
        updated_at: params[2],
      };
      return this.result([], 1);
    }
    return this.result([]);
  }

  private result(rows: unknown[], rowsWritten = 0): SqlResult {
    return { toArray: () => rows, one: () => rows[0], rowsWritten };
  }
}

const upload = {
  version: 1,
  triggerMessageId: "message-1",
  capturedAt: 100,
  repositories: [
    {
      status: "ready",
      position: 0,
      repoOwner: "acme",
      repoName: "web",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      truncated: false,
      omittedFileCount: 0,
      files: [
        {
          id: "file-1",
          path: "src/app.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          renderState: "renderable",
          patch: "diff --git a/src/app.ts b/src/app.ts\n",
        },
      ],
    },
  ],
};

function harness() {
  const sql = new MemoryDiffSql();
  const repository = {
    getSessionRepositories: () => [
      {
        position: 0,
        repoOwner: "acme",
        repoName: "web",
        isPrimary: true,
        row: { base_sha: "a".repeat(40) },
      },
    ],
    setSessionDiffBaselines: vi.fn(),
  } as unknown as SessionRepository;
  const messenger: SessionMessenger = {
    broadcast: vi.fn(),
    sendToSandbox: vi.fn(() => true),
  };
  const log: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => log,
  };
  const service = new SessionDiffService(
    new SessionDiffStore(sql),
    repository,
    messenger,
    log,
    () => "revision-1",
    () => 200
  );
  return { service, repository, messenger };
}

describe("SessionDiffService", () => {
  it("accepts one matching bundle and serves a revision-pinned patch", async () => {
    const { service, messenger } = harness();

    const uploaded = await service.handleUpload(
      new Request("http://internal/diff", { method: "POST", body: JSON.stringify(upload) })
    );

    expect(uploaded.status).toBe(200);
    await expect(uploaded.json()).resolves.toEqual({ revisionId: "revision-1" });
    expect(await (await service.handleState()).json()).toMatchObject({
      current: { revisionId: "revision-1" },
    });
    expect(
      await (
        await service.handleResolveFile(
          new URL("http://internal/file?revisionId=revision-1&fileId=file-1")
        )
      ).text()
    ).toContain("diff --git");
    expect(messenger.broadcast).toHaveBeenCalledWith({
      type: "diff_state_changed",
      revisionId: "revision-1",
      updatedAt: 200,
    });
  });

  it("rejects a mismatched repository set and immutable baselines", async () => {
    const { service } = harness();
    const request = (body: unknown) =>
      service.handleUpload(
        new Request("http://internal/diff", { method: "POST", body: JSON.stringify(body) })
      );

    expect((await request({ ...upload, repositories: [] })).status).toBe(400);
    expect(
      (
        await request({
          ...upload,
          repositories: [{ ...upload.repositories[0], baseSha: "c".repeat(40) }],
        })
      ).status
    ).toBe(400);
  });

  it("retains a successful bundle when a later refresh fails", async () => {
    const { service } = harness();
    await service.handleUpload(
      new Request("http://internal/diff", { method: "POST", body: JSON.stringify(upload) })
    );

    expect(
      (
        await service.handleFailure(
          new Request("http://internal/failure", {
            method: "POST",
            body: JSON.stringify({ error: "collector timed out" }),
          })
        )
      ).status
    ).toBe(204);
    expect(await (await service.handleState()).json()).toMatchObject({
      current: { revisionId: "revision-1" },
      lastError: { message: "collector timed out", occurredAt: 200 },
    });
  });

  it("accepts retry as a non-blocking refresh command", () => {
    const { service, messenger } = harness();

    const response = service.handleRetry();

    expect(response.status).toBe(202);
    expect(messenger.sendToSandbox).toHaveBeenCalledWith({ type: "refresh_diff" });
  });

  it("rejects retry when the sandbox is not connected", () => {
    const { service, messenger } = harness();
    vi.mocked(messenger.sendToSandbox).mockReturnValue(false);

    expect(service.handleRetry().status).toBe(409);
  });
});
