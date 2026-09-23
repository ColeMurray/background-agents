"use client";

import type { AutomationTriggerType } from "@open-inspect/shared/triggers";
import { MAX_AUTOMATION_INSTRUCTIONS_LENGTH } from "@open-inspect/shared/types/automations";
import { Textarea } from "@/components/ui/textarea";
import { FieldDescription } from "./automation-form-field";

const INSTRUCTIONS_WARNING_THRESHOLD = Math.floor(MAX_AUTOMATION_INSTRUCTIONS_LENGTH * 0.9);

const INSTRUCTION_PLACEHOLDERS: Partial<Record<AutomationTriggerType, string>> = {
  sentry:
    "Investigate this Sentry error. Find the root cause in the codebase, then open a PR with a fix.",
  github_event:
    "Review this pull request and provide feedback. Check for code quality issues, potential bugs, and suggest improvements.",
};

interface AutomationInstructionsFieldProps {
  value: string;
  triggerType: AutomationTriggerType;
  onChange: (value: string) => void;
}

export function AutomationInstructionsField({
  value,
  triggerType,
  onChange,
}: AutomationInstructionsFieldProps) {
  const placeholder =
    triggerType === "schedule"
      ? "Run the test suite and fix any failing tests. If all tests pass, look for TODO comments and address the most impactful one."
      : (INSTRUCTION_PLACEHOLDERS[triggerType] ??
        "Process this webhook payload and take the appropriate action.");

  const counterTone =
    value.length >= MAX_AUTOMATION_INSTRUCTIONS_LENGTH
      ? "text-destructive"
      : value.length >= INSTRUCTIONS_WARNING_THRESHOLD
        ? "text-warning"
        : "text-muted-foreground";

  return (
    <div>
      <label
        htmlFor="automation-instructions"
        className="block text-sm font-medium text-foreground mb-1.5"
      >
        Instructions
      </label>
      <FieldDescription className="mb-1.5">
        Main prompt for the agent when a run starts. For event-based triggers, a short summary of
        the event is inserted above this text.
      </FieldDescription>
      <Textarea
        id="automation-instructions"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        maxLength={MAX_AUTOMATION_INSTRUCTIONS_LENGTH}
        required
        rows={6}
        aria-describedby="instructions-counter"
        className="resize-y"
      />
      <div
        id="instructions-counter"
        aria-live="polite"
        className={`mt-1 text-xs text-right ${counterTone}`}
      >
        {value.length >= MAX_AUTOMATION_INSTRUCTIONS_LENGTH ? (
          <span>Maximum length reached. </span>
        ) : null}
        {value.length.toLocaleString()} / {MAX_AUTOMATION_INSTRUCTIONS_LENGTH.toLocaleString()}
      </div>
    </div>
  );
}
