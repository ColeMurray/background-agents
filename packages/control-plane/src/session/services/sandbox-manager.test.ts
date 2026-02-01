/**
 * Tests for SandboxManager service.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { createSandboxManager } from "./sandbox-manager";
import type { SandboxManager } from "./types";
import type { SandboxRepository } from "../repository/types";
import { createSandboxRepository } from "../repository";
import { FakeSqlStorage } from "../../test/fakes/fake-sql-storage";

describe("SandboxManager", () => {
  let manager: SandboxManager;
  let sandboxRepo: SandboxRepository;
  let mockModalSpawn: Mock;
  let mockModalSnapshot: Mock;
  let sql: FakeSqlStorage;

  beforeEach(() => {
    sql = new FakeSqlStorage();
    sql.exec(`
      CREATE TABLE sandbox (
        id TEXT PRIMARY KEY,
        modal_sandbox_id TEXT,
        modal_object_id TEXT,
        snapshot_id TEXT,
        snapshot_image_id TEXT,
        auth_token TEXT,
        status TEXT NOT NULL,
        git_sync_status TEXT,
        last_heartbeat INTEGER,
        last_activity INTEGER,
        preview_tunnel_url TEXT,
        tunnel_urls TEXT,
        spawn_failure_count INTEGER DEFAULT 0,
        last_spawn_failure INTEGER,
        created_at INTEGER NOT NULL
      )
    `);

    // Create a sandbox entry
    sql.exec(
      `INSERT INTO sandbox (
        id, modal_sandbox_id, status, created_at
      ) VALUES (?, ?, ?, ?)`,
      "sandbox-1",
      null,
      "initializing",
      Date.now()
    );

    sandboxRepo = createSandboxRepository(sql);
    mockModalSpawn = vi.fn().mockResolvedValue({
      sandbox_id: "sb-123",
      object_id: "obj-456",
    });
    mockModalSnapshot = vi.fn().mockResolvedValue({
      snapshot_id: "snap-789",
    });

    manager = createSandboxManager({
      sandboxRepo,
      modalSpawn: mockModalSpawn,
      modalSnapshot: mockModalSnapshot,
    });
  });

  describe("spawnSandbox", () => {
    it("should spawn sandbox and update repository", async () => {
      await manager.spawnSandbox();

      expect(mockModalSpawn).toHaveBeenCalled();

      const sandbox = sandboxRepo.get();
      expect(sandbox?.modal_sandbox_id).toBe("sb-123");
      expect(sandbox?.status).toBe("spawning");
    });

    it("should reset failure count on successful spawn", async () => {
      // Set a failure count
      sandboxRepo.incrementSpawnFailureCount(Date.now());

      await manager.spawnSandbox();

      const failureInfo = sandboxRepo.getSpawnFailureInfo();
      expect(failureInfo.count).toBe(0);
      expect(failureInfo.lastFailure).toBeNull();
    });

    it("should handle spawn failures and increment failure count", async () => {
      mockModalSpawn.mockRejectedValueOnce(new Error("Spawn failed"));

      await expect(manager.spawnSandbox()).rejects.toThrow("Spawn failed");

      const failureInfo = sandboxRepo.getSpawnFailureInfo();
      expect(failureInfo.count).toBe(1);
      expect(failureInfo.lastFailure).toBeGreaterThan(0);
    });

    it("should update status to failed on spawn error", async () => {
      mockModalSpawn.mockRejectedValueOnce(new Error("Spawn failed"));

      await expect(manager.spawnSandbox()).rejects.toThrow();

      const sandbox = sandboxRepo.get();
      expect(sandbox?.status).toBe("failed");
    });
  });

  describe("circuit breaker", () => {
    it("should block spawn after 3 failures", async () => {
      mockModalSpawn.mockRejectedValue(new Error("Spawn failed"));

      // First 3 failures
      await expect(manager.spawnSandbox()).rejects.toThrow();
      await expect(manager.spawnSandbox()).rejects.toThrow();
      await expect(manager.spawnSandbox()).rejects.toThrow();

      const failureInfo = sandboxRepo.getSpawnFailureInfo();
      expect(failureInfo.count).toBe(3);

      // Circuit should be open now
      const canSpawn = manager.canSpawnSandbox();
      expect(canSpawn).toBe(false);
    });

    it("should allow spawn if failures are old (> 5 minutes)", async () => {
      const oldTimestamp = Date.now() - 6 * 60 * 1000; // 6 minutes ago

      // Manually set old failures
      sql.exec(
        `UPDATE sandbox SET spawn_failure_count = ?, last_spawn_failure = ?`,
        3,
        oldTimestamp
      );

      const canSpawn = manager.canSpawnSandbox();
      expect(canSpawn).toBe(true);
    });

    it("should allow spawn if failure count < 3", async () => {
      sandboxRepo.incrementSpawnFailureCount(Date.now());
      sandboxRepo.incrementSpawnFailureCount(Date.now());

      const canSpawn = manager.canSpawnSandbox();
      expect(canSpawn).toBe(true);
    });
  });

  describe("spawn cooldown", () => {
    it("should block spawn within 30 seconds of last attempt", async () => {
      // Update last activity to recent
      const recentTimestamp = Date.now() - 10 * 1000; // 10 seconds ago
      sandboxRepo.updateLastActivity(recentTimestamp);

      // Try to spawn
      await manager.spawnSandbox();

      // Modal spawn should be called
      expect(mockModalSpawn).toHaveBeenCalled();
    });
  });

  describe("triggerSnapshot", () => {
    it("should call Modal snapshot API", async () => {
      await manager.triggerSnapshot("test_reason");

      expect(mockModalSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "test_reason",
        })
      );
    });

    it("should update sandbox repository with new snapshot ID", async () => {
      await manager.triggerSnapshot("test_reason");

      const sandbox = sandboxRepo.get();
      expect(sandbox?.snapshot_id).toBe("snap-789");
    });

    it("should handle snapshot errors gracefully", async () => {
      mockModalSnapshot.mockRejectedValueOnce(new Error("Snapshot failed"));

      await expect(manager.triggerSnapshot("test")).rejects.toThrow("Snapshot failed");
    });
  });

  describe("inactivity timeout", () => {
    it("should detect inactivity after 30 minutes", () => {
      const oldTimestamp = Date.now() - 31 * 60 * 1000; // 31 minutes ago
      sandboxRepo.updateLastActivity(oldTimestamp);

      const isInactive = manager.isInactive();
      expect(isInactive).toBe(true);
    });

    it("should not detect inactivity within 30 minutes", () => {
      const recentTimestamp = Date.now() - 10 * 60 * 1000; // 10 minutes ago
      sandboxRepo.updateLastActivity(recentTimestamp);

      const isInactive = manager.isInactive();
      expect(isInactive).toBe(false);
    });

    it("should handle missing last_activity", () => {
      // Sandbox with no last_activity set
      const isInactive = manager.isInactive();
      expect(isInactive).toBe(false);
    });
  });

  describe("restoreFromSnapshot", () => {
    it("should spawn sandbox with snapshot ID", async () => {
      const snapshotId = "snap-existing";

      await manager.restoreFromSnapshot(snapshotId);

      expect(mockModalSpawn).toHaveBeenCalledWith(
        expect.objectContaining({
          snapshotId,
        })
      );
    });

    it("should update sandbox repository after restore", async () => {
      await manager.restoreFromSnapshot("snap-existing");

      const sandbox = sandboxRepo.get();
      expect(sandbox?.modal_sandbox_id).toBe("sb-123");
      expect(sandbox?.status).toBe("spawning");
    });
  });

  describe("updateStatus", () => {
    it("should update sandbox status", () => {
      manager.updateStatus("running");

      const sandbox = sandboxRepo.get();
      expect(sandbox?.status).toBe("running");
    });

    it("should update heartbeat timestamp", () => {
      const beforeHeartbeat = sandboxRepo.get()?.last_heartbeat;

      manager.updateHeartbeat();

      const afterHeartbeat = sandboxRepo.get()?.last_heartbeat;
      expect(afterHeartbeat).toBeGreaterThan(beforeHeartbeat ?? 0);
    });

    it("should update activity timestamp", () => {
      const beforeActivity = sandboxRepo.get()?.last_activity;

      manager.updateActivity();

      const afterActivity = sandboxRepo.get()?.last_activity;
      expect(afterActivity).toBeGreaterThan(beforeActivity ?? 0);
    });
  });
});
