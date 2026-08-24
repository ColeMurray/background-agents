import { beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxRepository } from "./sandbox-repository";
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

function createMockSql(rowsWritten = 1) {
  const calls: Array<{ query: string; params: unknown[] }> = [];
  const data = new Map<string, unknown[]>();
  const sql: SqlStorage = {
    exec(query: string, ...params: unknown[]): SqlResult {
      calls.push({ query, params });
      return {
        toArray: () => data.get(query) ?? [],
        one: () => null,
        rowsWritten,
      };
    },
  };
  return {
    sql,
    calls,
    setData: (query: string, rows: unknown[]) => data.set(query, rows),
  };
}

describe("SandboxRepository", () => {
  let mock: ReturnType<typeof createMockSql>;
  let repository: SandboxRepository;
  let log: Logger;

  beforeEach(() => {
    mock = createMockSql();
    log = createLog();
    repository = new SandboxRepository(mock.sql, log);
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
    it("sets all spawn fields atomically", () => {
      repository.updateSandboxForSpawn({
        status: "spawning",
        createdAt: 1000,
        authTokenHash: "token-hash-123",
        modalSandboxId: "modal-sb-1",
      });

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE sandbox SET");
      expect(mock.calls[0].query).toContain("status");
      expect(mock.calls[0].query).toContain("auth_token_hash");
      expect(mock.calls[0].query).toContain("modal_sandbox_id");
      expect(mock.calls[0].query).toContain("auth_token = NULL");
      expect(mock.calls[0].query).toContain("modal_object_id = NULL");
      expect(mock.calls[0].query).toContain("vnc_url = NULL");
      expect(mock.calls[0].query).toContain("vnc_password = NULL");
      // A replacement sandbox must not inherit the predecessor's runtime.
      expect(mock.calls[0].query).toContain("runtime_version = NULL");
      expect(mock.calls[0].query).toContain("boot_progress_at = NULL");
      expect(mock.calls[0].params).toEqual(["spawning", 1000, "token-hash-123", "modal-sb-1"]);
    });

    it("can preserve the provider object ID while fencing a replacement", () => {
      repository.updateSandboxForSpawn({
        status: "spawning",
        createdAt: 123,
        authTokenHash: "hash",
        modalSandboxId: "sandbox-new",
        preserveProviderObjectId: true,
      });

      expect(mock.calls[0].query).toContain("modal_object_id = modal_object_id");
    });
  });

  it("clears stale boot progress when resuming", () => {
    repository.updateSandboxForResume({ status: "connecting", createdAt: 2000 });

    expect(mock.calls[0].query).toContain("boot_progress_at = NULL");
    expect(mock.calls[0].params).toEqual(["connecting", 2000]);
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

  describe("recordBootProgress", () => {
    it("fences progress by logical sandbox identity and boot status", () => {
      expect(repository.recordBootProgress("sandbox-current", 5000)).toBe(true);

      expect(mock.calls[0].query).toContain("modal_sandbox_id = ?");
      expect(mock.calls[0].query).toContain("status IN ('spawning', 'connecting')");
      expect(mock.calls[0].params).toEqual([5000, "sandbox-current"]);
    });

    it("returns false when the fenced update matches no sandbox", () => {
      const rejected = createMockSql(0);
      const rejectedRepository = new SandboxRepository(rejected.sql, log);

      expect(rejectedRepository.recordBootProgress("sandbox-stale", 5000)).toBe(false);
    });
  });

  describe("failBootIfUnchanged", () => {
    it("fences timeout failure by identity, status, and observed liveness", () => {
      expect(repository.failBootIfUnchanged("sandbox-current", 5000)).toBe(true);

      expect(mock.calls[0].query).toContain("status IN ('spawning', 'connecting')");
      expect(mock.calls[0].query).toContain("MAX(created_at, COALESCE(boot_progress_at, 0)) = ?");
      expect(mock.calls[0].params).toEqual(["sandbox-current", 5000]);
    });

    it("returns false when the fenced update matches no sandbox", () => {
      const rejected = createMockSql(0);
      const rejectedRepository = new SandboxRepository(rejected.sql, log);

      expect(rejectedRepository.failBootIfUnchanged("sandbox-stale", 5000)).toBe(false);
    });
  });

  describe("commitProviderStartup", () => {
    it("atomically fences all provider access fields by sandbox identity and startup status", () => {
      expect(
        repository.commitProviderStartup({
          expectedSandboxId: "sandbox-current",
          expectedCreatedAt: 1000,
          providerObjectId: "provider-1",
          codeServerUrl: "https://code.example",
          codeServerPassword: "encrypted-code",
          vncUrl: "https://vnc.example",
          vncPassword: "encrypted-vnc",
          tunnelUrls: '{"3000":"https://tunnel.example"}',
          ttydUrl: "https://terminal.example",
          ttydToken: "encrypted-terminal",
          preserveMissing: false,
        })
      ).toBe(true);

      expect(mock.calls[0].query).toContain("status IN ('spawning', 'connecting', 'ready')");
      expect(mock.calls[0].query).toContain("modal_object_id = COALESCE(?, modal_object_id)");
      expect(mock.calls[0].query).toContain("created_at = ?");
      expect(mock.calls[0].params.slice(-2)).toEqual(["sandbox-current", 1000]);
    });

    it("returns false when the fenced update matches no sandbox", () => {
      const rejected = createMockSql(0);
      const rejectedRepository = new SandboxRepository(rejected.sql, log);

      expect(
        rejectedRepository.commitProviderStartup({
          expectedSandboxId: "sandbox-stale",
          expectedCreatedAt: 1000,
          providerObjectId: "provider-1",
          codeServerUrl: null,
          codeServerPassword: null,
          vncUrl: null,
          vncPassword: null,
          tunnelUrls: null,
          ttydUrl: null,
          ttydToken: null,
          preserveMissing: false,
        })
      ).toBe(false);
    });

    it("preserves missing access fields during resume", () => {
      repository.commitProviderStartup({
        expectedSandboxId: "sandbox-current",
        expectedCreatedAt: 1000,
        providerObjectId: "provider-1",
        codeServerUrl: null,
        codeServerPassword: null,
        vncUrl: null,
        vncPassword: null,
        tunnelUrls: null,
        ttydUrl: null,
        ttydToken: null,
        preserveMissing: true,
      });

      expect(mock.calls[0].query).toContain("code_server_url = COALESCE(?, code_server_url)");
      expect(mock.calls[0].query).toContain("ttyd_token = COALESCE(?, ttyd_token)");
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

  describe("updateSandboxSpawnError", () => {
    it("updates spawn error fields", () => {
      repository.updateSandboxSpawnError("Failed to spawn sandbox", 123456);

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].query).toContain("UPDATE sandbox SET last_spawn_error");
      expect(mock.calls[0].params).toEqual(["Failed to spawn sandbox", 123456]);
    });
  });

  describe("VNC access", () => {
    it("stores and clears VNC credentials", () => {
      repository.updateSandboxVnc("https://vnc.test", "encrypted-password");
      repository.clearSandboxVnc();

      expect(mock.calls[0].query).toContain("SET vnc_url = ?, vnc_password = ?");
      expect(mock.calls[0].params).toEqual(["https://vnc.test", "encrypted-password"]);
      expect(mock.calls[1].query).toContain("SET vnc_url = NULL, vnc_password = NULL");
    });

    it("can clear only the VNC URL", () => {
      repository.clearSandboxVncUrl();

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
