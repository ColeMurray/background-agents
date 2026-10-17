"use client";

import { getHarnessLabel, isValidHarness, type HarnessId } from "@open-inspect/shared/harnesses";
import { AVAILABLE_HARNESS_IDS } from "@/lib/available-harnesses";
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
  disabled,
  supportsPi = true,
}: {
  id?: string;
  value: HarnessId | undefined;
  onChange: (harness: HarnessId | undefined) => void;
  inheritLabel?: string;
  density?: "compact";
  className?: string;
  describedBy?: string;
  /** Passed to the root so an open menu closes and its options stop responding. */
  disabled?: boolean;
  /** Repository-only integrations cannot use the current no-repository Pi runtime. */
  supportsPi?: boolean;
}) {
  const harnesses = supportsPi
    ? AVAILABLE_HARNESS_IDS
    : AVAILABLE_HARNESS_IDS.filter((harness) => harness !== "pi");
  return (
    <Select
      disabled={disabled}
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
        {harnesses.map((harness) => (
          <SelectItem key={harness} value={harness}>
            {getHarnessLabel(harness)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
