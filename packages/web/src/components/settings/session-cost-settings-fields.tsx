import { useState } from "react";
import {
  DEFAULT_COST_WARNING_THRESHOLD_PCT,
  type SandboxSettings,
} from "@open-inspect/shared/types/integrations";
import { Input } from "@/components/ui/input";

interface SessionCostSettingsFieldsProps {
  isGlobal: boolean;
  maxSessionCostUsd: string;
  costWarningThresholdPct: string;
  onMaxSessionCostUsdChange: (value: string) => void;
  onCostWarningThresholdPctChange: (value: string) => void;
}

export function SessionCostSettingsFields({
  isGlobal,
  maxSessionCostUsd,
  costWarningThresholdPct,
  onMaxSessionCostUsdChange,
  onCostWarningThresholdPctChange,
}: SessionCostSettingsFieldsProps) {
  return (
    <fieldset className="min-w-0">
      <legend className="block text-sm font-medium text-foreground mb-1.5">Session Cost</legend>
      <p className="text-xs text-muted-foreground mb-2">
        Stops additional model work after reported session cost reaches the limit. Leave the limit
        blank {isGlobal ? "for unlimited sessions" : "to inherit the broader setting"}. Unreported
        model cost cannot be limited.
      </p>
      <div className="grid gap-3 max-w-sm sm:grid-cols-2">
        <div>
          <label
            htmlFor="max-session-cost-usd"
            className="block text-xs font-medium text-muted-foreground mb-1"
          >
            Cost limit (USD)
          </label>
          <Input
            id="max-session-cost-usd"
            type="number"
            min="0.01"
            step="0.01"
            inputMode="decimal"
            value={maxSessionCostUsd}
            onChange={(event) => onMaxSessionCostUsdChange(event.target.value)}
            placeholder={isGlobal ? "No limit" : "Inherit"}
          />
        </div>
        <div>
          <label
            htmlFor="cost-warning-threshold"
            className="block text-xs font-medium text-muted-foreground mb-1"
          >
            Warning threshold (%)
          </label>
          <Input
            id="cost-warning-threshold"
            type="number"
            min="1"
            max="99"
            inputMode="numeric"
            value={costWarningThresholdPct}
            onChange={(event) => onCostWarningThresholdPctChange(event.target.value)}
            placeholder="Inherit default"
          />
        </div>
      </div>
    </fieldset>
  );
}

function validateSessionCostSettings(
  maxSessionCostUsd: string,
  costWarningThresholdPct: string
): string | null {
  if (
    maxSessionCostUsd !== "" &&
    (!Number.isFinite(Number(maxSessionCostUsd)) || Number(maxSessionCostUsd) <= 0)
  ) {
    return "Session cost limit must be a positive USD amount.";
  }
  if (
    costWarningThresholdPct !== "" &&
    (!Number.isInteger(Number(costWarningThresholdPct)) ||
      Number(costWarningThresholdPct) < 1 ||
      Number(costWarningThresholdPct) > 99)
  ) {
    return "Cost warning threshold must be a whole percentage from 1 to 99.";
  }
  return null;
}

function applySessionCostSettings(
  target: SandboxSettings,
  input: {
    isGlobal: boolean;
    maxCostEdit: string | null;
    resolvedMaxCost: string;
    thresholdEdit: string | null;
    resolvedThreshold: string;
    own: SandboxSettings | undefined;
  }
): void {
  if (input.isGlobal || input.maxCostEdit !== null || input.own?.maxSessionCostUsd !== undefined) {
    if (input.resolvedMaxCost !== "") {
      target.maxSessionCostUsd = Number(input.resolvedMaxCost);
    }
  }
  if (input.thresholdEdit !== null || input.own?.costWarningThresholdPct !== undefined) {
    if (input.resolvedThreshold !== "") {
      target.costWarningThresholdPct = Number(input.resolvedThreshold);
    }
  }
}

export function useSessionCostSettings(
  own: SandboxSettings | undefined,
  base: SandboxSettings | undefined,
  isGlobal: boolean
) {
  const currentMaxCost = own?.maxSessionCostUsd ?? base?.maxSessionCostUsd;
  const currentThreshold = own?.costWarningThresholdPct ?? base?.costWarningThresholdPct;
  const [maxCostEdit, setMaxCostEdit] = useState<string | null>(null);
  const [thresholdEdit, setThresholdEdit] = useState<string | null>(null);
  const maxCost = maxCostEdit ?? (currentMaxCost === undefined ? "" : String(currentMaxCost));
  const threshold =
    thresholdEdit ??
    (currentThreshold === undefined
      ? isGlobal
        ? String(DEFAULT_COST_WARNING_THRESHOLD_PCT)
        : ""
      : String(currentThreshold));
  const initialThreshold =
    currentThreshold === undefined
      ? isGlobal
        ? String(DEFAULT_COST_WARNING_THRESHOLD_PCT)
        : ""
      : String(currentThreshold);

  return {
    maxCost,
    threshold,
    setMaxCost: setMaxCostEdit,
    setThreshold: setThresholdEdit,
    validate: () => validateSessionCostSettings(maxCost.trim(), threshold.trim()),
    apply: (target: SandboxSettings) =>
      applySessionCostSettings(target, {
        isGlobal,
        maxCostEdit,
        resolvedMaxCost: maxCost.trim(),
        thresholdEdit,
        resolvedThreshold: threshold.trim(),
        own,
      }),
    reset: () => {
      setMaxCostEdit(null);
      setThresholdEdit(null);
    },
    hasChanges:
      (maxCostEdit !== null && maxCostEdit.trim() !== (currentMaxCost?.toString() ?? "")) ||
      (thresholdEdit !== null && thresholdEdit !== initialThreshold),
  };
}
