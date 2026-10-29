"use client";

import { useState } from "react";
import type { BulkSkillImportPreviewResponse } from "@open-inspect/shared/types/skills";
import { Checkbox } from "@/components/ui/checkbox";
import { SkillImportReview } from "./skill-import-review";

function selectionKey(subdirectory: string | null): string {
  return subdirectory ?? "";
}

function SkillReviewDetails({
  skill,
}: {
  skill: BulkSkillImportPreviewResponse["skills"][number];
}) {
  const [open, setOpen] = useState(false);

  return (
    <details className="mt-2 pl-7" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-xs font-medium text-foreground">
        Review full details
      </summary>
      {open && (
        <div className="mt-3">
          <SkillImportReview preview={skill} />
        </div>
      )}
    </details>
  );
}

export function BulkSkillImportReview({
  preview,
  selectedRoots,
  onToggle,
  onToggleAll,
}: {
  preview: BulkSkillImportPreviewResponse;
  selectedRoots: Set<string>;
  onToggle: (root: string, checked: boolean) => void;
  onToggleAll: (checked: boolean) => void;
}) {
  const available = preview.skills.filter((skill) => skill.nameAvailable);
  const selectedCount = available.filter((skill) =>
    selectedRoots.has(selectionKey(skill.source.subdirectory))
  ).length;
  const allSelected = available.length > 0 && selectedCount === available.length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-border-muted p-3">
        <div>
          <p className="text-sm font-medium text-foreground">
            {preview.skills.length} skill{preview.skills.length === 1 ? "" : "s"} discovered
          </p>
          <p className="text-xs text-muted-foreground">
            {preview.totalFiles.toLocaleString()} files · {preview.totalBytes.toLocaleString()}{" "}
            bytes
          </p>
          <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
            Commit {preview.commitSha}
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-foreground">
          <Checkbox
            aria-label="Select all available skills"
            checked={allSelected ? true : selectedCount > 0 ? "indeterminate" : false}
            disabled={available.length === 0}
            onCheckedChange={(value) => onToggleAll(value === true)}
          />
          Select all available ({selectedCount}/{available.length})
        </label>
      </div>

      <div className="divide-y divide-border-muted rounded border border-border-muted">
        {preview.skills.map((skill) => {
          const root = selectionKey(skill.source.subdirectory);
          return (
            <div key={root} className="p-3">
              <div className="flex items-start gap-3">
                <Checkbox
                  aria-label={`Select ${skill.name}`}
                  checked={skill.nameAvailable && selectedRoots.has(root)}
                  disabled={!skill.nameAvailable}
                  onCheckedChange={(value) => onToggle(root, value === true)}
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-medium text-foreground">
                      {skill.name}
                    </span>
                    <span
                      className={
                        skill.nameAvailable
                          ? "rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-300"
                          : "rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive"
                      }
                    >
                      {skill.nameAvailable ? "Available" : "Unavailable name"}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {skill.warnings.length} warning{skill.warnings.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {skill.description}
                  </p>
                  <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                    {skill.source.subdirectory ?? "Repository root"}
                  </p>
                </div>
              </div>
              <SkillReviewDetails skill={skill} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
