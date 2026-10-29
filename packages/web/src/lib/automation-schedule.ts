import { describeCron } from "@open-inspect/shared/cron";
import type { Automation } from "@open-inspect/shared/types/automations";

/** Describe a schedule consistently in lists and details, including its configured timezone. */
export function describeAutomationSchedule(
  automation: Pick<Automation, "scheduleCron" | "scheduleOnceAt" | "scheduleTz">,
  options?: { compact: boolean }
): string {
  if (automation.scheduleOnceAt != null) {
    return `Once at ${new Date(automation.scheduleOnceAt).toLocaleString(undefined, {
      timeZone: automation.scheduleTz,
      timeZoneName: "short",
    })}`;
  }
  return automation.scheduleCron
    ? describeCron(automation.scheduleCron, automation.scheduleTz, options)
    : "Schedule (no cron)";
}
