/**
 * SandboxRepository implementation using SQLite.
 */

import type { SandboxRepository } from "./types";
import type { SandboxRow, SandboxUpdate } from "../types";

/**
 * Create a SandboxRepository instance backed by SQLite.
 */
export function createSandboxRepository(sql: SqlStorage): SandboxRepository {
  return {
    get(): SandboxRow | null {
      const result = sql.exec(`SELECT * FROM sandbox LIMIT 1`);
      const rows = result.toArray() as unknown as SandboxRow[];
      return rows.length > 0 ? rows[0] : null;
    },

    create(data: Omit<SandboxRow, "created_at">): SandboxRow {
      const now = Date.now();

      sql.exec(
        `INSERT INTO sandbox (
          id, modal_sandbox_id, modal_object_id, snapshot_id, snapshot_image_id,
          auth_token, status, git_sync_status, last_heartbeat, last_activity,
          preview_tunnel_url, tunnel_urls, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        data.id,
        data.modal_sandbox_id,
        data.modal_object_id,
        data.snapshot_id,
        data.snapshot_image_id,
        data.auth_token,
        data.status,
        data.git_sync_status,
        data.last_heartbeat,
        data.last_activity,
        data.preview_tunnel_url,
        data.tunnel_urls,
        now
      );

      const created = this.get();
      if (!created) {
        throw new Error("Failed to create sandbox");
      }
      return created;
    },

    update(updates: SandboxUpdate): void {
      const sets: string[] = [];
      const params: (string | number | null)[] = [];

      if (updates.modalSandboxId !== undefined) {
        sets.push("modal_sandbox_id = ?");
        params.push(updates.modalSandboxId);
      }

      if (updates.snapshotId !== undefined) {
        sets.push("snapshot_id = ?");
        params.push(updates.snapshotId);
      }

      if (updates.status !== undefined) {
        sets.push("status = ?");
        params.push(updates.status);
      }

      if (updates.gitSyncStatus !== undefined) {
        sets.push("git_sync_status = ?");
        params.push(updates.gitSyncStatus);
      }

      if (sets.length === 0) {
        return;
      }

      sql.exec(`UPDATE sandbox SET ${sets.join(", ")}`, ...params);
    },

    updateStatus(status: string): void {
      sql.exec(`UPDATE sandbox SET status = ?`, status);
    },

    updateGitSyncStatus(status: string): void {
      sql.exec(`UPDATE sandbox SET git_sync_status = ?`, status);
    },

    updateLastHeartbeat(timestamp: number): void {
      sql.exec(`UPDATE sandbox SET last_heartbeat = ?`, timestamp);
    },

    updateLastActivity(timestamp: number): void {
      sql.exec(`UPDATE sandbox SET last_activity = ?`, timestamp);
    },

    updatePreviewTunnelUrl(url: string | null): void {
      sql.exec(`UPDATE sandbox SET preview_tunnel_url = ?`, url);
    },

    updateTunnelUrls(tunnelUrls: string | null): void {
      sql.exec(`UPDATE sandbox SET tunnel_urls = ?`, tunnelUrls);
    },

    updateSnapshot(snapshotId: string, snapshotImageId?: string | null): void {
      if (snapshotImageId !== undefined) {
        sql.exec(
          `UPDATE sandbox SET snapshot_id = ?, snapshot_image_id = ?`,
          snapshotId,
          snapshotImageId
        );
      } else {
        sql.exec(`UPDATE sandbox SET snapshot_id = ?`, snapshotId);
      }
    },

    incrementSpawnFailureCount(timestamp: number): void {
      const sandbox = this.get();
      const currentCount = sandbox?.spawn_failure_count ?? 0;

      sql.exec(
        `UPDATE sandbox SET spawn_failure_count = ?, last_spawn_failure = ?`,
        currentCount + 1,
        timestamp
      );
    },

    resetSpawnFailureCount(): void {
      sql.exec(`UPDATE sandbox SET spawn_failure_count = ?, last_spawn_failure = ?`, 0, null);
    },

    getSpawnFailureInfo(): { count: number; lastFailure: number | null } {
      const sandbox = this.get();
      return {
        count: sandbox?.spawn_failure_count ?? 0,
        lastFailure: sandbox?.last_spawn_failure ?? null,
      };
    },
  };
}
