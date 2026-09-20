import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxRepository } from "./sandbox-repository";
import { initSchema } from "./schema";
import { createNodeSqlStorage } from "../node/sqlite-storage";
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

  describe("transitionSandboxStatus", () => {
    const query = `UPDATE sandbox SET status = ?
       WHERE id = (SELECT id FROM sandbox LIMIT 1)
         AND modal_sandbox_id IS ? AND created_at = ? AND status = ?`;
    const generation = { sandboxId: "modal-sb-1", createdAt: 5000 };

    it("moves the row only while it is still the generation's and in the expected status", () => {
      mock.setRowsWritten(query, 1);

      expect(repository.transitionSandboxStatus(generation, "snapshotting", "ready")).toBe(true);
      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toBe(query);
      expect(mock.calls[0].params).toEqual(["ready", "modal-sb-1", 5000, "snapshotting"]);
    });

    it("reports a row that another event or attempt moved instead of overwriting it", () => {
      expect(repository.transitionSandboxStatus(generation, "spawning", "connecting")).toBe(false);
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
    const query = `UPDATE sandbox SET auth_token_hash = ? WHERE modal_sandbox_id = ? AND status = 'spawning'`;

    it("publishes the hash scoped to the reserved identity", () => {
      mock.setRowsWritten(query, 1);

      expect(repository.updateSandboxAuthTokenHash("modal-sb-1", "hash-1")).toBe(true);
      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toBe(query);
      expect(mock.calls[0].params).toEqual(["hash-1", "modal-sb-1"]);
    });

    it("reports a superseded or stopped reservation instead of touching the current row", () => {
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

  describe("recordSandboxSnapshot", () => {
    const query = `UPDATE sandbox SET snapshot_image_id = ?, snapshot_runtime_version = ?
       WHERE id = (SELECT id FROM sandbox LIMIT 1) AND modal_sandbox_id IS ?`;

    it("stamps the snapshot with the runtime that produced it, for the sandbox it was taken of", () => {
      mock.setRowsWritten(query, 1);

      expect(repository.recordSandboxSnapshot("modal-sb-1", "img-123", "v59-runtime")).toBe(true);
      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toBe(query);
      expect(mock.calls[0].params).toEqual(["img-123", "v59-runtime", "modal-sb-1"]);
    });

    it("records a null runtime when the sandbox never reported one", () => {
      repository.recordSandboxSnapshot("modal-sb-1", "img-123", null);

      expect(mock.calls[0].params).toEqual(["img-123", null, "modal-sb-1"]);
    });

    it("reports a replaced sandbox instead of stamping its successor", () => {
      expect(repository.recordSandboxSnapshot("modal-sb-old", "img-123", null)).toBe(false);
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

/**
 * Boot-phase, readiness and fencing writes are guarded UPDATEs whose whole
 * meaning is in their WHERE clause, so they run against a real SQLite schema
 * rather than a query-string mock.
 */
describe("SandboxRepository boot state (SQLite)", () => {
  function createSqliteRepository() {
    const db = new DatabaseSync(":memory:");
    const { sql } = createNodeSqlStorage(db);
    initSchema(sql);
    const repository = new SandboxRepository(sql, createLog(), TEST_ENCRYPTION_KEY);
    repository.createSandbox({
      id: "row-1",
      status: "pending",
      gitSyncStatus: "pending",
      createdAt: 1000,
    });
    const set = (assignments: string, ...params: unknown[]) =>
      sql.exec(`UPDATE sandbox SET ${assignments}`, ...params);
    return { db, sql, repository, set };
  }

  describe("markSandboxReady", () => {
    const generation = { sandboxId: "sb-1", createdAt: 1000 };

    it.each(["spawning", "connecting", "snapshotting", "warming"] as const)(
      "moves a %s row to ready, clears its boot phase, and reports the transition",
      (status) => {
        const { repository, set } = createSqliteRepository();
        set(
          "status = ?, modal_sandbox_id = 'sb-1', boot_phase = ?, boot_seq = ?",
          status,
          '{"phase":"setup"}',
          4
        );

        expect(repository.markSandboxReady(generation)).toBe(true);

        const row = repository.getSandbox();
        expect(row?.status).toBe("ready");
        expect(row?.boot_phase).toBeNull();
        expect(row?.boot_seq).toBeNull();
      }
    );

    it("is transition-only: a ready row reports no change", () => {
      const { repository, set } = createSqliteRepository();
      set("status = 'ready', modal_sandbox_id = 'sb-1'");

      expect(repository.markSandboxReady(generation)).toBe(false);
    });

    it.each(["stopped", "stale"] as const)("leaves a %s row alone", (status) => {
      const { repository, set } = createSqliteRepository();
      set("status = ?, modal_sandbox_id = 'sb-1'", status);

      expect(repository.markSandboxReady(generation)).toBe(false);
      expect(repository.getSandbox()?.status).toBe(status);
    });

    it("lets an unfenced failed row self-heal but refuses a fenced one", () => {
      const healed = createSqliteRepository();
      healed.set("status = 'failed', modal_sandbox_id = 'sb-1', fenced = 0");
      expect(healed.repository.markSandboxReady(generation)).toBe(true);
      expect(healed.repository.getSandbox()?.status).toBe("ready");

      const fenced = createSqliteRepository();
      fenced.set("status = 'failed', modal_sandbox_id = 'sb-1', fenced = 1");
      expect(fenced.repository.markSandboxReady(generation)).toBe(false);
      expect(fenced.repository.getSandbox()?.status).toBe("failed");
    });

    it("refuses a ready that belongs to a generation the row no longer holds", () => {
      // A replacement reserved the row while the old runtime's ready was in
      // flight: the replacement's own ready, not this one, may move it.
      const { repository, set } = createSqliteRepository();
      set("status = 'spawning', modal_sandbox_id = 'sb-2', created_at = 2000");

      expect(repository.markSandboxReady(generation)).toBe(false);
      expect(repository.markSandboxReady({ sandboxId: "sb-1", createdAt: 2000 })).toBe(false);
      expect(repository.getSandbox()?.status).toBe("spawning");

      expect(repository.markSandboxReady({ sandboxId: "sb-2", createdAt: 2000 })).toBe(true);
    });

    it("matches a generation that has no sandbox id yet", () => {
      const { repository, set } = createSqliteRepository();
      set("status = 'connecting', modal_sandbox_id = NULL");

      expect(repository.markSandboxReady({ sandboxId: null, createdAt: 1000 })).toBe(true);
    });
  });

  describe("recordBootProgress", () => {
    const phase = {
      phase: "setup",
      status: "started",
      repoOwner: "acme",
      repoName: "api",
    } as const;

    it("stores the phase with its sequence the first time it is seen", () => {
      const { repository, set } = createSqliteRepository();
      set("status = 'connecting'");

      expect(repository.recordBootProgress(phase, 3)).toBe(true);

      const row = repository.getSandbox();
      expect(row?.boot_seq).toBe(3);
      expect(JSON.parse(row!.boot_phase!)).toEqual(phase);
    });

    it.each(["ready", "snapshotting", "stopped", "stale"] as const)(
      "ignores a phase resent to a %s row: the boot it describes is over",
      (status) => {
        const { repository, set } = createSqliteRepository();
        set("status = ?", status);

        expect(repository.recordBootProgress(phase, 3)).toBe(false);

        const row = repository.getSandbox();
        expect(row?.boot_phase).toBeNull();
        expect(row?.boot_seq).toBeNull();
      }
    );

    it("still records phases for an unfenced failed row whose boot outlived the watchdog", () => {
      const { repository, set } = createSqliteRepository();
      set("status = 'failed', fenced = 0");

      expect(repository.recordBootProgress(phase, 3)).toBe(true);
    });

    it("ignores a repeated or older sequence and accepts a newer one", () => {
      const { repository, set } = createSqliteRepository();
      set("status = 'connecting'");
      repository.recordBootProgress(phase, 3);

      expect(repository.recordBootProgress(phase, 3)).toBe(false);
      expect(repository.recordBootProgress(phase, 2)).toBe(false);
      expect(
        repository.recordBootProgress({ ...phase, phase: "start", status: "started" }, 4)
      ).toBe(true);
      expect(repository.getSandbox()?.boot_seq).toBe(4);
    });
  });

  describe("fenceSandboxGeneration", () => {
    it("revokes the token hash and socket authority and marks the row fenced", () => {
      const { repository, set } = createSqliteRepository();
      set(
        "status = 'connecting', auth_token_hash = 'hash', auth_token = 'tok', active_socket_id = 'sbws-1'"
      );

      repository.fenceSandboxGeneration();

      const row = repository.getSandbox();
      expect(row?.auth_token_hash).toBe("");
      expect(row?.auth_token).toBeNull();
      expect(row?.active_socket_id).toBe("");
      expect(row?.fenced).toBe(1);
    });
  });

  describe("reservation clears boot state", () => {
    it("updateSandboxForSpawn resets the boot phase, sequence and fence", () => {
      const { repository, set } = createSqliteRepository();
      set("status = 'failed', boot_phase = '{}', boot_seq = 9, fenced = 1");

      repository.updateSandboxForSpawn({
        status: "spawning",
        createdAt: 2000,
        modalSandboxId: "sb-2",
      });

      const row = repository.getSandbox();
      expect(row?.boot_phase).toBeNull();
      expect(row?.boot_seq).toBeNull();
      expect(row?.fenced).toBe(0);
    });

    it("updateSandboxForResume resets the fence as well", () => {
      const { repository, set } = createSqliteRepository();
      set("status = 'stopped', fenced = 1");

      repository.updateSandboxForResume({ status: "connecting", createdAt: 2000 });

      expect(repository.getSandbox()?.fenced).toBe(0);
    });
  });

  it("exposes last_heartbeat to the spawn decision", () => {
    const { repository, set } = createSqliteRepository();
    set("status = 'connecting', last_heartbeat = 4242");

    expect(repository.getSandboxWithCircuitBreaker()?.last_heartbeat).toBe(4242);
  });
});
