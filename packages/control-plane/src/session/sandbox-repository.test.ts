import { beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxRepository } from "./sandbox-repository";
import { decryptToken, generateEncryptionKey } from "../auth/crypto";
import type { SqlResult, SqlStorage } from "./sql-storage";
import type { Logger } from "../logger";

function createLog() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
}

function createMockSql() {
  const calls: Array<{ query: string; params: unknown[] }> = [];
  const data = new Map<string, unknown[]>();
  const written = new Map<string, number>();
  const sql: SqlStorage = {
    exec(query: string, ...params: unknown[]): SqlResult {
      calls.push({ query, params });
      return {
        toArray: () => data.get(query) ?? [],
        one: () => null,
        rowsWritten: written.get(query) ?? 0,
      };
    },
  };
  return {
    sql,
    calls,
    setData: (query: string, rows: unknown[]) => data.set(query, rows),
    setRowsWritten: (query: string, rows: number) => written.set(query, rows),
  };
}

const TEST_ENCRYPTION_KEY = generateEncryptionKey();

describe("SandboxRepository", () => {
  let mock: ReturnType<typeof createMockSql>;
  let repository: SandboxRepository;
  let log: Logger;

  beforeEach(() => {
    mock = createMockSql();
    log = createLog();
    repository = new SandboxRepository(mock.sql, log, TEST_ENCRYPTION_KEY);
  });

  describe("getSandbox", () => {
    it("returns null when no sandbox exists", () => {
      mock.setData(`SELECT * FROM sandbox LIMIT 1`, []);
      expect(repository.getSandbox()).toBeNull();
    });

    it("returns sandbox when it exists", () => {
      const sandbox = { id: "sb-1", status: "ready" };
      mock.setData(`SELECT * FROM sandbox LIMIT 1`, [sandbox]);
      expect(repository.getSandbox()).toEqual(sandbox);
    });

    // This is the read boundary for the sandbox row: the column is bare TEXT
    // with no CHECK constraint and roughly forty sites consume this status, so
    // validating here is what stops the same row meaning different things to
    // different callers. `failed` is the conservative landing spot -- it
    // refuses to reuse a sandbox we cannot classify while still allowing a
    // clean spawn, where `pending` would let it be picked up as if fresh.
    it("validates an unmodelled status to failed and warns", () => {
      mock.setData(`SELECT * FROM sandbox LIMIT 1`, [{ id: "sb-1", status: "running" }]);

      expect(repository.getSandbox()).toEqual({ id: "sb-1", status: "failed" });
      expect(log.warn).toHaveBeenCalledWith(
        "sandbox.status.unrecognized",
        expect.objectContaining({ status: "running" })
      );
    });

    it("leaves a missing status as pending without warning", () => {
      mock.setData(`SELECT * FROM sandbox LIMIT 1`, [{ id: "sb-1", status: null }]);

      expect(repository.getSandbox()).toEqual({ id: "sb-1", status: "pending" });
      expect(log.warn).not.toHaveBeenCalled();
    });
  });

  describe("createSandbox", () => {
    it("creates sandbox with correct parameters", () => {
      repository.createSandbox({
        id: "sb-1",
        status: "pending",
        gitSyncStatus: "pending",
        createdAt: 1000,
      });

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("INSERT INTO sandbox");
      expect(mock.calls[0].params).toEqual(["sb-1", "pending", "pending", 1000]);
    });
  });

  describe("updateSandboxStatus", () => {
    it("updates status", () => {
      repository.updateSandboxStatus("ready");

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE sandbox SET status");
      expect(mock.calls[0].params).toEqual(["ready"]);
    });
  });

  describe("updateSandboxForSpawn", () => {
    it("sets all spawn fields atomically and invalidates credentials", () => {
      repository.updateSandboxForSpawn({
        status: "spawning",
        createdAt: 1000,
        modalSandboxId: "modal-sb-1",
      });

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE sandbox SET");
      expect(mock.calls[0].query).toContain("status");
      expect(mock.calls[0].query).toContain("modal_sandbox_id");
      // The reservation itself empties the hash (#1589 phase 1) — no caller
      // can accidentally reserve with live credentials.
      expect(mock.calls[0].query).toContain("auth_token_hash = ''");
      expect(mock.calls[0].query).toContain("auth_token = NULL");
      expect(mock.calls[0].query).toContain("modal_object_id = NULL");
      expect(mock.calls[0].query).toContain("vnc_url = NULL");
      expect(mock.calls[0].query).toContain("vnc_password = NULL");
      // A replacement sandbox must not inherit the predecessor's runtime.
      expect(mock.calls[0].query).toContain("runtime_version = NULL");
      // ...nor its bridge: the predecessor's socket loses dispatch authority
      // here. Revoked is '' — NULL is reserved for rows that predate identities.
      expect(mock.calls[0].query).toContain("active_socket_id = ''");
      expect(mock.calls[0].params).toEqual(["spawning", 1000, "modal-sb-1"]);
    });

    it("can preserve the provider object ID while fencing a replacement", () => {
      repository.updateSandboxForSpawn({
        status: "spawning",
        createdAt: 123,
        modalSandboxId: "sandbox-new",
        preserveProviderObjectId: true,
      });

      expect(mock.calls[0].query).toContain("modal_object_id = modal_object_id");
    });
  });

  describe("active socket id", () => {
    it("writes the identity to the session's one sandbox row", () => {
      repository.setActiveSocketId("sbws-2");

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE sandbox SET active_socket_id = ?");
      expect(mock.calls[0].params).toEqual(["sbws-2"]);
    });

    it("revokes with the empty sentinel rather than NULL", () => {
      repository.revokeActiveSocketId();

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE sandbox SET active_socket_id = ''");
      expect(mock.calls[0].params).toEqual([]);
    });
  });

  describe("updateSandboxAuthTokenHash", () => {
    const query = `UPDATE sandbox SET auth_token_hash = ? WHERE modal_sandbox_id = ?`;

    it("publishes the hash scoped to the reserved identity", () => {
      mock.setRowsWritten(query, 1);

      expect(repository.updateSandboxAuthTokenHash("modal-sb-1", "hash-1")).toBe(true);
      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toBe(query);
      expect(mock.calls[0].params).toEqual(["hash-1", "modal-sb-1"]);
    });

    it("reports a superseded reservation instead of touching the current row", () => {
      expect(repository.updateSandboxAuthTokenHash("modal-sb-stale", "hash-1")).toBe(false);
    });
  });

  describe("updateSandboxModalObjectId", () => {
    it("updates modal object ID", () => {
      repository.updateSandboxModalObjectId("obj-123");

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE sandbox SET modal_object_id");
      expect(mock.calls[0].params).toEqual(["obj-123"]);
    });
  });

  describe("updateSandboxSnapshotImageId", () => {
    it("stamps the snapshot with the runtime that produced it", () => {
      repository.updateSandboxSnapshotImageId("sb-1", "img-123", "v59-runtime");

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE sandbox SET snapshot_image_id");
      expect(mock.calls[0].query).toContain("snapshot_runtime_version");
      expect(mock.calls[0].params).toEqual(["img-123", "v59-runtime", "sb-1"]);
    });

    it("records a null runtime when the sandbox never reported one", () => {
      repository.updateSandboxSnapshotImageId("sb-1", "img-123", null);

      expect(mock.calls[0].params).toEqual(["img-123", null, "sb-1"]);
    });
  });

  describe("updateSandboxRuntimeVersion", () => {
    it("records the running sandbox's runtime version", () => {
      repository.updateSandboxRuntimeVersion("v59-runtime");

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE sandbox SET runtime_version");
      expect(mock.calls[0].params).toEqual(["v59-runtime"]);
    });

    it("clears the recorded version when set to null", () => {
      repository.updateSandboxRuntimeVersion(null);

      expect(mock.calls[0].params).toEqual([null]);
    });
  });

  describe("recordReportedSandboxRuntimeVersion", () => {
    it("only fills a row with nothing recorded yet", () => {
      repository.recordReportedSandboxRuntimeVersion("v59-runtime");

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE sandbox SET runtime_version");
      // A restore seeds the snapshot's version first; the sandbox's own report
      // must not overwrite it.
      expect(mock.calls[0].query).toContain("runtime_version IS NULL");
      expect(mock.calls[0].params).toEqual(["v59-runtime"]);
    });
  });

  describe("updateSandboxHeartbeat", () => {
    it("updates heartbeat timestamp", () => {
      repository.updateSandboxHeartbeat(5000);

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE sandbox SET last_heartbeat");
      expect(mock.calls[0].params).toEqual([5000]);
    });
  });

  describe("updateSandboxLastActivity", () => {
    it("updates activity timestamp", () => {
      repository.updateSandboxLastActivity(6000);

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE sandbox SET last_activity");
      expect(mock.calls[0].params).toEqual([6000]);
    });
  });

  describe("updateSandboxGitSyncStatus", () => {
    it("updates git sync status", () => {
      repository.updateSandboxGitSyncStatus("completed");

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE sandbox SET git_sync_status");
      expect(mock.calls[0].params).toEqual(["completed"]);
    });
  });

  describe("setLastSpawnError", () => {
    it("updates spawn error fields", () => {
      repository.setLastSpawnError("Failed to spawn sandbox", 123456);

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE sandbox SET last_spawn_error");
      expect(mock.calls[0].params).toEqual(["Failed to spawn sandbox", 123456]);
    });
  });

  describe("access artifacts", () => {
    it("stores encrypted credentials and clears them", async () => {
      await repository.updateSandboxAccess("vnc", "https://vnc.test", "vnc-secret");
      repository.clearSandboxAccess("vnc");

      expect(mock.calls[0].query).toContain("SET vnc_url = ?, vnc_password = ?");
      const [url, stored] = mock.calls[0].params as [string, string];
      expect(url).toBe("https://vnc.test");
      expect(stored).not.toBe("vnc-secret");
      await expect(decryptToken(stored, TEST_ENCRYPTION_KEY)).resolves.toBe("vnc-secret");
      expect(mock.calls[1].query).toContain("SET vnc_url = NULL, vnc_password = NULL");
    });

    it("encrypts code-server and ttyd secrets the same way", async () => {
      await repository.updateSandboxAccess("codeServer", "https://cs.test", "cs-secret");
      await repository.updateSandboxAccess("ttyd", "https://ttyd.test", "ttyd-token");

      expect(mock.calls[0].query).toContain("SET code_server_url = ?, code_server_password = ?");
      expect(mock.calls[1].query).toContain("SET ttyd_url = ?, ttyd_token = ?");
      for (const [call, plaintext] of [
        [mock.calls[0], "cs-secret"],
        [mock.calls[1], "ttyd-token"],
      ] as const) {
        const stored = call.params[1] as string;
        expect(stored).not.toBe(plaintext);
        await expect(decryptToken(stored, TEST_ENCRYPTION_KEY)).resolves.toBe(plaintext);
      }
    });

    it("can clear only the URL", () => {
      repository.clearSandboxAccessUrl("vnc");

      expect(mock.calls[0].query).toContain("SET vnc_url = NULL");
      expect(mock.calls[0].query).not.toContain("vnc_password");
    });
  });

  describe("resetCircuitBreaker", () => {
    it("resets failure count to zero", () => {
      repository.resetCircuitBreaker();

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("spawn_failure_count = 0");
    });
  });

  describe("incrementCircuitBreakerFailure", () => {
    it("increments count and sets timestamp", () => {
      repository.incrementCircuitBreakerFailure(7000);

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("spawn_failure_count = COALESCE");
      expect(mock.calls[0].query).toContain("last_spawn_failure");
      expect(mock.calls[0].params).toEqual([7000]);
    });
  });
});
