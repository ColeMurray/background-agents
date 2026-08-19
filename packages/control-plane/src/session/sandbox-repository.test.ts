import { beforeEach, describe, expect, it } from "vitest";
import { SandboxRepository } from "./sandbox-repository";
import type { SqlResult, SqlStorage } from "./sql-storage";

function createMockSql() {
  const calls: Array<{ query: string; params: unknown[] }> = [];
  const data = new Map<string, unknown[]>();
  const sql: SqlStorage = {
    exec(query: string, ...params: unknown[]): SqlResult {
      calls.push({ query, params });
      return {
        toArray: () => data.get(query) ?? [],
        one: () => null,
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

  beforeEach(() => {
    mock = createMockSql();
    repository = new SandboxRepository(mock.sql);
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
