import type { AutomationInvocationStatus } from "@open-inspect/shared/types/automations";

export type AutomationInvocationTone = "neutral" | "info" | "success" | "danger" | "warning";

export const AUTOMATION_INVOCATION_STATUS: Record<
  AutomationInvocationStatus,
  { label: string; tone: AutomationInvocationTone }
> = {
  starting: { label: "Starting", tone: "neutral" },
  running: { label: "Running", tone: "info" },
  completed: { label: "Completed", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  partial_failed: { label: "Partial failure", tone: "warning" },
  skipped: { label: "Skipped", tone: "warning" },
};
