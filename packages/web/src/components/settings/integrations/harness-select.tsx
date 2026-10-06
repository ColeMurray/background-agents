"use client";

import {
  HARNESS_IDS,
  getHarnessLabel,
  isValidHarness,
  type HarnessId,
} from "@open-inspect/shared/harnesses";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const INHERIT_VALUE = "__inherit__";

/**
 * Harness picker for integration settings. With `inheritLabel`, it also offers
 * leaving the harness unset so the level inherits it (`undefined`).
 */
export function HarnessSelect({
  id,
  value,
  onChange,
  inheritLabel,
  density,
  className,
  describedBy,
}: {
  id?: string;
  value: HarnessId | undefined;
  onChange: (harness: HarnessId | undefined) => void;
  inheritLabel?: string;
  density?: "compact";
  className?: string;
  describedBy?: string;
}) {
  return (
    <Select
      value={value ?? INHERIT_VALUE}
      onValueChange={(next) => onChange(isValidHarness(next) ? next : undefined)}
    >
      <SelectTrigger
        id={id}
        density={density}
        className={className}
        aria-label="Agent harness"
        aria-describedby={describedBy}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {inheritLabel && <SelectItem value={INHERIT_VALUE}>{inheritLabel}</SelectItem>}
        {HARNESS_IDS.map((harness) => (
          <SelectItem key={harness} value={harness}>
            {getHarnessLabel(harness)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
