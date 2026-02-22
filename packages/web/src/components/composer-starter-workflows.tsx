"use client";

import type { ComposerCommand } from "@/lib/composer-commands";

interface ComposerStarterWorkflowsProps {
  workflows: ComposerCommand[];
  disabled: boolean;
  onSelect: (workflow: ComposerCommand) => void;
}

export function ComposerStarterWorkflows({
  workflows,
  disabled,
  onSelect,
}: ComposerStarterWorkflowsProps) {
  if (workflows.length === 0) return null;

  return (
    <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
      {workflows.map((workflow) => (
        <button
          key={workflow.id}
          type="button"
          onClick={() => onSelect(workflow)}
          disabled={disabled}
          className="border border-border bg-background px-3 py-2 text-left hover:bg-muted transition disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <p className="text-sm text-foreground">{workflow.starterTitle || workflow.title}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {workflow.starterDescription || workflow.description}
          </p>
        </button>
      ))}
    </div>
  );
}
