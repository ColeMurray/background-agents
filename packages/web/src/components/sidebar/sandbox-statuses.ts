import type { SandboxStatus } from "@open-inspect/shared/types/sessions";

/** Sandbox statuses where sandbox service links are usable. */
export const ACTIVE_SANDBOX_STATUSES: Set<SandboxStatus> = new Set([
  "ready",
  "running",
  "snapshotting",
]);

export const STARTING_SANDBOX_STATUSES: Set<SandboxStatus> = new Set([
  "pending",
  "spawning",
  "connecting",
  "warming",
  "syncing",
]);
