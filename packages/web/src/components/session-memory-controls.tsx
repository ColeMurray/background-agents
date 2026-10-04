"use client";

import { useId } from "react";
import { MEMORY_TYPES, type MemorySelectionSummary } from "@open-inspect/shared/types/memories";
import {
  MEMORY_TYPE_LABELS,
  PERSONAL_MEMORY_DISCLOSURE,
  type PersonalMemoryChoice,
} from "@/lib/memories";
import { Checkbox } from "@/components/ui/checkbox";

/** The checkbox state for a choice; an unknown saved default renders as indeterminate. */
function personalMemoryChecked(
  choice: PersonalMemoryChoice,
  savedDefault: boolean | undefined
): boolean | "indeterminate" {
  switch (choice) {
    case "default":
      return savedDefault ?? "indeterminate";
    case "include":
      return true;
    case "exclude":
      return false;
  }
}

function previewSummary(preview: MemorySelectionSummary): string {
  const counts = MEMORY_TYPES.map((type) => {
    const count = preview.items.filter((item) => item.memoryType === type).length;
    return `${count} ${MEMORY_TYPE_LABELS[type].plural}`;
  });
  const omitted = preview.truncatedCount ? ` · ${preview.truncatedCount} omitted` : "";
  return `${counts.join(", ")} will load · about ${preview.estimatedTokens.toLocaleString()} tokens${omitted}`;
}

/**
 * Memory controls for a new session: override the saved personal-memory default, and preview
 * everything that will load (directives and facts from every scope, not only personal ones).
 */
export function SessionMemoryControls({
  choice,
  savedDefault,
  onChange,
  preview,
  preferencesLoading,
  previewLoading,
  error,
  onRetry,
  disabled = false,
}: {
  choice: PersonalMemoryChoice;
  savedDefault: boolean | undefined;
  onChange: (choice: PersonalMemoryChoice) => void;
  preview?: MemorySelectionSummary;
  preferencesLoading: boolean;
  previewLoading: boolean;
  error?: unknown;
  onRetry?: () => void;
  disabled?: boolean;
}) {
  const checkboxId = useId();
  const checked = personalMemoryChecked(choice, savedDefault);
  return (
    <div className="mb-3 space-y-1 px-4 text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <Checkbox
          id={checkboxId}
          disabled={disabled}
          checked={checked}
          onCheckedChange={(value) => onChange(value === true ? "include" : "exclude")}
        />
        <label htmlFor={checkboxId}>Include my personal memories</label>
      </div>
      <p>
        {checked === "indeterminate"
          ? "Using your saved personal-memory preference. Choose explicitly to override it for this session."
          : checked
            ? PERSONAL_MEMORY_DISCLOSURE
            : "Personal memories will not be loaded or available to memory tools."}
      </p>
      {preferencesLoading ? (
        <p>Loading memory preferences…</p>
      ) : error ? (
        <p role="alert">
          Unable to load memory preferences or preview.{" "}
          {onRetry && (
            <button type="button" className="underline" onClick={onRetry}>
              Retry
            </button>
          )}
        </p>
      ) : previewLoading ? (
        <p>Loading memory preview…</p>
      ) : preview ? (
        <p>{previewSummary(preview)}</p>
      ) : null}
    </div>
  );
}
