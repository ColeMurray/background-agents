/**
 * Tests for SandboxRepository implementation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { FakeSqlStorage } from "../../test/fakes/fake-sql-storage";
import { createSandboxRepository } from "./sandbox-repository";
import { initSchema } from "../schema";
import type { SandboxRepository } from "./types";

describe("SandboxRepository", () => {
  let sql: FakeSqlStorage;
  let repo: SandboxRepository;

  beforeEach(() => {
    sql = new FakeSqlStorage();
    initSchema(sql as unknown as SqlStorage);
    repo = createSandboxRepository(sql as unknown as SqlStorage);
  });

  describe("create", () => {
    it("should create a new sandbox", () => {
      const now = Date.now();
      const sandbox = repo.create({
        id: "sandbox-1",
        modal_sandbox_id: null,
        modal_object_id: null,
        snapshot_id: null,
        snapshot_image_id: null,
        auth_token: "token-123",
        status: "pending",
        git_sync_status: "pending",
        last_heartbeat: null,
        last_activity: null,
        preview_tunnel_url: null,
        tunnel_urls: null,
        created_at: now,
      });

      expect(sandbox.id).toBe("sandbox-1");
      expect(sandbox.status).toBe("pending");
      expect(sandbox.git_sync_status).toBe("pending");
      expect(sandbox.auth_token).toBe("token-123");
      expect(sandbox.created_at).toBe(now);
    });
  });

  describe("get", () => {
    it("should return null when sandbox does not exist", () => {
      const sandbox = repo.get();
      expect(sandbox).toBeNull();
    });

    it("should return sandbox when it exists", () => {
      repo.create({
        id: "sandbox-1",
        modal_sandbox_id: null,
        modal_object_id: null,
        snapshot_id: null,
        snapshot_image_id: null,
        auth_token: "token-123",
        status: "pending",
        git_sync_status: "pending",
        last_heartbeat: null,
        last_activity: null,
        preview_tunnel_url: null,
        tunnel_urls: null,
        created_at: Date.now(),
      });

      const sandbox = repo.get();
      expect(sandbox).not.toBeNull();
      expect(sandbox?.id).toBe("sandbox-1");
    });
  });

  describe("update", () => {
    beforeEach(() => {
      repo.create({
        id: "sandbox-1",
        modal_sandbox_id: null,
        modal_object_id: null,
        snapshot_id: null,
        snapshot_image_id: null,
        auth_token: "token-123",
        status: "pending",
        git_sync_status: "pending",
        last_heartbeat: null,
        last_activity: null,
        preview_tunnel_url: null,
        tunnel_urls: null,
        created_at: Date.now(),
      });
    });

    it("should update modal sandbox ID", () => {
      repo.update({ modalSandboxId: "modal-123" });

      const sandbox = repo.get();
      expect(sandbox?.modal_sandbox_id).toBe("modal-123");
    });

    it("should update snapshot ID", () => {
      repo.update({ snapshotId: "snapshot-456" });

      const sandbox = repo.get();
      expect(sandbox?.snapshot_id).toBe("snapshot-456");
    });

    it("should update status", () => {
      repo.update({ status: "ready" });

      const sandbox = repo.get();
      expect(sandbox?.status).toBe("ready");
    });

    it("should update git sync status", () => {
      repo.update({ gitSyncStatus: "completed" });

      const sandbox = repo.get();
      expect(sandbox?.git_sync_status).toBe("completed");
    });
  });

  describe("updateStatus", () => {
    beforeEach(() => {
      repo.create({
        id: "sandbox-1",
        modal_sandbox_id: null,
        modal_object_id: null,
        snapshot_id: null,
        snapshot_image_id: null,
        auth_token: "token-123",
        status: "pending",
        git_sync_status: "pending",
        last_heartbeat: null,
        last_activity: null,
        preview_tunnel_url: null,
        tunnel_urls: null,
        created_at: Date.now(),
      });
    });

    it("should update status", () => {
      repo.updateStatus("running");

      const sandbox = repo.get();
      expect(sandbox?.status).toBe("running");
    });
  });

  describe("updateGitSyncStatus", () => {
    beforeEach(() => {
      repo.create({
        id: "sandbox-1",
        modal_sandbox_id: null,
        modal_object_id: null,
        snapshot_id: null,
        snapshot_image_id: null,
        auth_token: "token-123",
        status: "pending",
        git_sync_status: "pending",
        last_heartbeat: null,
        last_activity: null,
        preview_tunnel_url: null,
        tunnel_urls: null,
        created_at: Date.now(),
      });
    });

    it("should update git sync status", () => {
      repo.updateGitSyncStatus("in_progress");

      const sandbox = repo.get();
      expect(sandbox?.git_sync_status).toBe("in_progress");
    });
  });

  describe("updateLastHeartbeat", () => {
    beforeEach(() => {
      repo.create({
        id: "sandbox-1",
        modal_sandbox_id: null,
        modal_object_id: null,
        snapshot_id: null,
        snapshot_image_id: null,
        auth_token: "token-123",
        status: "running",
        git_sync_status: "completed",
        last_heartbeat: null,
        last_activity: null,
        preview_tunnel_url: null,
        tunnel_urls: null,
        created_at: Date.now(),
      });
    });

    it("should update last heartbeat timestamp", () => {
      const now = Date.now();
      repo.updateLastHeartbeat(now);

      const sandbox = repo.get();
      expect(sandbox?.last_heartbeat).toBe(now);
    });
  });

  describe("updateLastActivity", () => {
    beforeEach(() => {
      repo.create({
        id: "sandbox-1",
        modal_sandbox_id: null,
        modal_object_id: null,
        snapshot_id: null,
        snapshot_image_id: null,
        auth_token: "token-123",
        status: "running",
        git_sync_status: "completed",
        last_heartbeat: null,
        last_activity: null,
        preview_tunnel_url: null,
        tunnel_urls: null,
        created_at: Date.now(),
      });
    });

    it("should update last activity timestamp", () => {
      const now = Date.now();
      repo.updateLastActivity(now);

      const sandbox = repo.get();
      expect(sandbox?.last_activity).toBe(now);
    });
  });

  describe("updatePreviewTunnelUrl", () => {
    beforeEach(() => {
      repo.create({
        id: "sandbox-1",
        modal_sandbox_id: null,
        modal_object_id: null,
        snapshot_id: null,
        snapshot_image_id: null,
        auth_token: "token-123",
        status: "running",
        git_sync_status: "completed",
        last_heartbeat: null,
        last_activity: null,
        preview_tunnel_url: null,
        tunnel_urls: null,
        created_at: Date.now(),
      });
    });

    it("should update preview tunnel URL", () => {
      repo.updatePreviewTunnelUrl("https://preview.example.com");

      const sandbox = repo.get();
      expect(sandbox?.preview_tunnel_url).toBe("https://preview.example.com");
    });

    it("should clear preview tunnel URL", () => {
      repo.updatePreviewTunnelUrl("https://preview.example.com");
      repo.updatePreviewTunnelUrl(null);

      const sandbox = repo.get();
      expect(sandbox?.preview_tunnel_url).toBeNull();
    });
  });

  describe("updateTunnelUrls", () => {
    beforeEach(() => {
      repo.create({
        id: "sandbox-1",
        modal_sandbox_id: null,
        modal_object_id: null,
        snapshot_id: null,
        snapshot_image_id: null,
        auth_token: "token-123",
        status: "running",
        git_sync_status: "completed",
        last_heartbeat: null,
        last_activity: null,
        preview_tunnel_url: null,
        tunnel_urls: null,
        created_at: Date.now(),
      });
    });

    it("should update tunnel URLs JSON", () => {
      const tunnelUrls = JSON.stringify({ 5173: "https://preview.example.com" });
      repo.updateTunnelUrls(tunnelUrls);

      const sandbox = repo.get();
      expect(sandbox?.tunnel_urls).toBe(tunnelUrls);
    });
  });

  describe("updateSnapshot", () => {
    beforeEach(() => {
      repo.create({
        id: "sandbox-1",
        modal_sandbox_id: null,
        modal_object_id: null,
        snapshot_id: null,
        snapshot_image_id: null,
        auth_token: "token-123",
        status: "running",
        git_sync_status: "completed",
        last_heartbeat: null,
        last_activity: null,
        preview_tunnel_url: null,
        tunnel_urls: null,
        created_at: Date.now(),
      });
    });

    it("should update snapshot ID", () => {
      repo.updateSnapshot("snapshot-123");

      const sandbox = repo.get();
      expect(sandbox?.snapshot_id).toBe("snapshot-123");
      expect(sandbox?.snapshot_image_id).toBeNull();
    });

    it("should update snapshot ID and image ID", () => {
      repo.updateSnapshot("snapshot-123", "image-456");

      const sandbox = repo.get();
      expect(sandbox?.snapshot_id).toBe("snapshot-123");
      expect(sandbox?.snapshot_image_id).toBe("image-456");
    });
  });

  describe("circuit breaker", () => {
    beforeEach(() => {
      repo.create({
        id: "sandbox-1",
        modal_sandbox_id: null,
        modal_object_id: null,
        snapshot_id: null,
        snapshot_image_id: null,
        auth_token: "token-123",
        status: "pending",
        git_sync_status: "pending",
        last_heartbeat: null,
        last_activity: null,
        preview_tunnel_url: null,
        tunnel_urls: null,
        created_at: Date.now(),
      });
    });

    it("should track spawn failure count", () => {
      const now = Date.now();
      repo.incrementSpawnFailureCount(now);

      const info = repo.getSpawnFailureInfo();
      expect(info.count).toBe(1);
      expect(info.lastFailure).toBe(now);
    });

    it("should increment spawn failure count", () => {
      repo.incrementSpawnFailureCount(Date.now());
      repo.incrementSpawnFailureCount(Date.now());
      repo.incrementSpawnFailureCount(Date.now());

      const info = repo.getSpawnFailureInfo();
      expect(info.count).toBe(3);
    });

    it("should reset spawn failure count", () => {
      repo.incrementSpawnFailureCount(Date.now());
      repo.incrementSpawnFailureCount(Date.now());
      repo.resetSpawnFailureCount();

      const info = repo.getSpawnFailureInfo();
      expect(info.count).toBe(0);
      expect(info.lastFailure).toBeNull();
    });

    it("should return zero count when no failures", () => {
      const info = repo.getSpawnFailureInfo();
      expect(info.count).toBe(0);
      expect(info.lastFailure).toBeNull();
    });
  });
});
