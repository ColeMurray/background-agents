"use client";

import type { AutomationTriggerType } from "@open-inspect/shared";

interface TriggerOption {
  type: AutomationTriggerType;
  label: string;
  description: string;
  comingSoon?: boolean;
}

const TRIGGER_OPTIONS: TriggerOption[] = [
  {
    type: "schedule",
    label: "Schedule",
    description: "Run on a cron schedule",
  },
  {
    type: "sentry",
    label: "Sentry",
    description: "Trigger on new errors or metric alerts",
  },
  {
    type: "webhook",
    label: "Inbound Webhook",
    description: "Trigger via HTTP POST from any system",
  },
  {
    type: "github_event",
    label: "GitHub Event",
    description: "Trigger on PR, issue, or CI events",
    comingSoon: true,
  },
  {
    type: "linear_event",
    label: "Linear Event",
    description: "Trigger on Linear issue events",
    comingSoon: true,
  },
];

interface TriggerTypeSelectorProps {
  value: AutomationTriggerType;
  onChange: (type: AutomationTriggerType) => void;
  disabled?: boolean;
}

export function TriggerTypeSelector({ value, onChange, disabled }: TriggerTypeSelectorProps) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
      {TRIGGER_OPTIONS.map((option) => {
        const isSelected = value === option.type;
        const isDisabled = disabled || option.comingSoon;

        return (
          <button
            key={option.type}
            type="button"
            onClick={() => !isDisabled && onChange(option.type)}
            disabled={isDisabled}
            className={`relative rounded-md border p-3 text-left transition text-sm ${
              isSelected
                ? "border-accent bg-accent/5 ring-1 ring-accent"
                : isDisabled
                  ? "border-border-muted bg-background/50 opacity-60 cursor-not-allowed"
                  : "border-border hover:border-foreground/20 cursor-pointer"
            }`}
          >
            <div className="font-medium text-foreground">{option.label}</div>
            <div className="text-xs text-muted-foreground mt-0.5">{option.description}</div>
            {option.comingSoon && (
              <span className="absolute top-1.5 right-1.5 text-[10px] font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                Soon
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
