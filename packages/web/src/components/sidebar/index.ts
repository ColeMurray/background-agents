import type { SandboxStatus } from "@open-inspect/shared";

/** Sandbox statuses where tunnel/code-server links are usable. */
export const ACTIVE_SANDBOX_STATUSES: Set<SandboxStatus> = new Set([
  "ready",
  "running",
  "snapshotting",
]);

export { CollapsibleSection } from "./collapsible-section";
export { ParticipantsSection } from "./participants-section";
export { MetadataSection } from "./metadata-section";
export { TasksSection } from "./tasks-section";
export { FilesChangedSection } from "./files-changed-section";
export { CodeServerSection } from "./code-server-section";
export { TunnelUrlsSection } from "./tunnel-urls-section";
