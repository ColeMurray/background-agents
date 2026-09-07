import { useState } from "react";
import type { SandboxSettings } from "@open-inspect/shared/types/integrations";
import { Input } from "@/components/ui/input";

interface SessionCostSettingsFieldsProps {
  isGlobal: boolean;
  maxSessionCostUsd: string;
  onMaxSessionCostUsdChange: (value: string) => void;
}

export function SessionCostSettingsFields({
  isGlobal,
  maxSessionCostUsd,
  onMaxSessionCostUsdChange,
}: SessionCostSettingsFieldsProps) {
  return (
    <fieldset className="min-w-0">
      <legend className="block text-sm font-medium text-foreground mb-1.5">Session Cost</legend>
      <p className="text-xs text-muted-foreground mb-2">
        Stops additional model work after reported session cost reaches the limit. Leave the limit
        blank {isGlobal ? "for unlimited sessions" : "to inherit the broader setting"}. Unreported
        model cost cannot be limited.
      </p>
      <div className="max-w-sm">
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
    </fieldset>
  );
}

export function useSessionCostSettings(
  own: SandboxSettings | undefined,
  base: SandboxSettings | undefined,
  isGlobal: boolean
) {
  const currentMaxCost = own?.maxSessionCostUsd ?? base?.maxSessionCostUsd;
  const [maxCostEdit, setMaxCostEdit] = useState<string | null>(null);
  const maxCost = maxCostEdit ?? (currentMaxCost === undefined ? "" : String(currentMaxCost));
  const trimmedMaxCost = maxCost.trim();

  return {
    maxCost,
    setMaxCost: setMaxCostEdit,
    validate: () =>
      trimmedMaxCost !== "" &&
      (!Number.isFinite(Number(trimmedMaxCost)) || Number(trimmedMaxCost) <= 0)
        ? "Session cost limit must be a positive USD amount."
        : null,
    apply: (target: SandboxSettings) => {
      if (
        trimmedMaxCost !== "" &&
        (isGlobal || maxCostEdit !== null || own?.maxSessionCostUsd !== undefined)
      ) {
        target.maxSessionCostUsd = Number(trimmedMaxCost);
      }
    },
    reset: () => setMaxCostEdit(null),
    hasChanges: maxCostEdit !== null && trimmedMaxCost !== (currentMaxCost?.toString() ?? ""),
  };
}
