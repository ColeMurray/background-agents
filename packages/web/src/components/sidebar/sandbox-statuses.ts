import type { SandboxStatus } from "@open-inspect/shared";

/** Sandbox statuses where tunnel/code-server links are usable. */
export const ACTIVE_SANDBOX_STATUSES: Set<SandboxStatus> = new Set([
  "ready",
  "running",
  "snapshotting",
]);
