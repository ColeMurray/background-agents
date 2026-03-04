/**
 * Pure logic for CronPicker preset detection and generation.
 */

export type PresetType = "hourly" | "daily" | "weekly" | "monthly" | "custom";

export interface DetectedPreset {
  type: PresetType;
  hour: number;
  dayOfWeek: string;
  dayOfMonth: number;
}

const DEFAULTS: DetectedPreset = { type: "custom", hour: 9, dayOfWeek: "1", dayOfMonth: 1 };

/**
 * Detect which preset a cron expression matches (if any).
 */
export function detectPreset(cron: string): DetectedPreset {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return DEFAULTS;

  const [min, hour, dom, mon, dow] = parts;

  // Hourly: 0 * * * *
  if (min === "0" && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    return { ...DEFAULTS, type: "hourly" };
  }

  // Daily: 0 H * * *
  if (min === "0" && /^\d+$/.test(hour) && dom === "*" && mon === "*" && dow === "*") {
    return { ...DEFAULTS, type: "daily", hour: parseInt(hour) };
  }

  // Weekly: 0 H * * D
  if (min === "0" && /^\d+$/.test(hour) && dom === "*" && mon === "*" && /^\d$/.test(dow)) {
    return { ...DEFAULTS, type: "weekly", hour: parseInt(hour), dayOfWeek: dow };
  }

  // Monthly: 0 H D * *
  if (min === "0" && /^\d+$/.test(hour) && /^\d+$/.test(dom) && mon === "*" && dow === "*") {
    const d = parseInt(dom);
    if (d >= 1 && d <= 28) {
      return { ...DEFAULTS, type: "monthly", hour: parseInt(hour), dayOfMonth: d };
    }
  }

  return DEFAULTS;
}

/**
 * Build a cron expression from a preset type and its parameters.
 */
export function buildCron(
  type: PresetType,
  hour: number,
  dayOfWeek: string,
  dayOfMonth: number
): string {
  switch (type) {
    case "hourly":
      return "0 * * * *";
    case "daily":
      return `0 ${hour} * * *`;
    case "weekly":
      return `0 ${hour} * * ${dayOfWeek}`;
    case "monthly":
      return `0 ${hour} ${dayOfMonth} * *`;
    default:
      return "";
  }
}
