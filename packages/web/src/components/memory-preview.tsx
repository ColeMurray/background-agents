"use client";

import type { SessionMemoryManifest } from "@open-inspect/shared/types/memories";

export function MemoryPreview({
  includePersonalMemories,
  onChange,
  preview,
  loading,
  error,
  onRetry,
  disabled = false,
}: {
  includePersonalMemories: boolean | undefined;
  onChange: (value: boolean) => void;
  preview?: SessionMemoryManifest;
  loading: boolean;
  error?: unknown;
  onRetry?: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="mb-3 space-y-1 px-4 text-xs text-muted-foreground">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          disabled={disabled}
          checked={includePersonalMemories ?? false}
          aria-checked={includePersonalMemories === undefined ? "mixed" : includePersonalMemories}
          ref={(input) => {
            if (input) input.indeterminate = includePersonalMemories === undefined;
          }}
          onChange={(event) => onChange(event.target.checked)}
        />
        Include my personal memories
      </label>
      <p>
        {includePersonalMemories === undefined
          ? "Using your saved personal-memory preference. Choose explicitly to override it for this session."
          : includePersonalMemories
            ? "Included memories may appear in responses and be visible to collaborators."
            : "Personal memories will not be loaded or available to memory tools."}
      </p>
      {loading ? (
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
      ) : preview ? (
        <p>
          {preview.items.filter((item) => item.inclusion === "directive").length} directives,{" "}
          {preview.items.filter((item) => item.inclusion === "catalog").length} facts will load ·
          about {preview.estimatedTokens.toLocaleString()} tokens
          {preview.truncatedCount ? ` · ${preview.truncatedCount} omitted` : ""}
        </p>
      ) : null}
    </div>
  );
}
