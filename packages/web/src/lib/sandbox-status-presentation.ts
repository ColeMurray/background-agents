import type { SandboxStatus as SandboxStatusValue } from "@open-inspect/shared/types/sessions";

export type SandboxStatusPresentation = {
  label: string;
  detail: string;
  color: string;
  dot: string;
  pulse?: boolean;
};

export const SANDBOX_STATUS_PRESENTATION: Record<SandboxStatusValue, SandboxStatusPresentation> = {
  pending: {
    label: "Pending",
    detail: "Waiting for the sandbox to start.",
    color: "text-muted-foreground",
    dot: "bg-muted-foreground",
  },
  warming: {
    label: "Warming...",
    detail: "Preparing sandbox capacity.",
    color: "text-warning",
    dot: "bg-warning",
    pulse: true,
  },
  spawning: {
    label: "Starting...",
    detail: "Creating or restoring the sandbox.",
    color: "text-warning",
    dot: "bg-warning",
    pulse: true,
  },
  connecting: {
    label: "Connecting...",
    detail: "Waiting for the sandbox runtime to connect.",
    color: "text-warning",
    dot: "bg-warning",
    pulse: true,
  },
  ready: {
    label: "Ready",
    detail: "The sandbox is available.",
    color: "text-success",
    dot: "bg-success",
  },
  snapshotting: {
    label: "Saving...",
    detail: "Saving a sandbox snapshot.",
    color: "text-accent",
    dot: "bg-accent",
    pulse: true,
  },
  stopped: {
    label: "Stopped",
    detail: "The sandbox stopped after inactivity and can restart with the next prompt.",
    color: "text-muted-foreground",
    dot: "bg-muted-foreground",
  },
  stale: {
    label: "Unresponsive",
    detail: "The sandbox runtime stopped responding.",
    color: "text-destructive",
    dot: "bg-destructive",
  },
  failed: {
    label: "Failed",
    detail: "The sandbox could not start or recover.",
    color: "text-destructive",
    dot: "bg-destructive",
  },
};
