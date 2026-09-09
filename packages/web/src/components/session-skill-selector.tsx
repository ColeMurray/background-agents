"use client";

import type { SessionSkillSelection } from "@open-inspect/shared/types/skills";
import {
  useSkillProfiles,
  type SkillResolutionPreviewInput,
  type SkillResolutionPreviewResponse,
} from "@/hooks/use-managed-skills";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { SparkleIcon } from "@/components/ui/icons";

interface SessionSkillSelectorProps {
  value: SessionSkillSelection;
  onChange: (value: SessionSkillSelection) => void;
  target: Omit<SkillResolutionPreviewInput, "selection"> | null;
  preview: SkillResolutionPreviewResponse | null;
  previewLoading: boolean;
  disabled?: boolean;
}

function selectionValue(selection: SessionSkillSelection): string {
  return selection.mode === "profile" ? `profile:${selection.profileId}` : selection.mode;
}

export function SessionSkillSelector({
  value,
  onChange,
  target,
  preview,
  previewLoading,
  disabled,
}: SessionSkillSelectorProps) {
  const { profiles, loading } = useSkillProfiles();
  const valueKey = selectionValue(value);
  const ignoredCount = preview?.ignoredProfileSkillIds.length ?? 0;

  const options: ComboboxOption[] = [
    {
      value: "all",
      label: "All applicable",
      description: "Use every skill assigned to this target",
    },
    { value: "none", label: "None", description: "Start without managed skills" },
    ...profiles.map((profile) => ({
      value: `profile:${profile.id}`,
      label: profile.name,
      description: `${profile.skillIds.length} selected skill${profile.skillIds.length === 1 ? "" : "s"}`,
    })),
  ];
  const selectedLabel =
    value.mode === "all"
      ? "all skills"
      : value.mode === "none"
        ? "no skills"
        : (profiles.find((profile) => profile.id === value.profileId)?.name ?? "skill profile");

  return (
    <Combobox
      value={valueKey}
      onChange={(next) => {
        if (next === "all" || next === "none") onChange({ mode: next });
        else onChange({ mode: "profile", profileId: next.slice("profile:".length) });
      }}
      items={options}
      direction="up"
      dropdownWidth="w-64"
      disabled={disabled || loading}
      triggerClassName="flex max-w-full items-center gap-1 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition"
    >
      <SparkleIcon className="h-3.5 w-3.5" />
      <span className="max-w-[9rem] truncate">{selectedLabel}</span>
      {target && (
        <span className="text-xs text-muted-foreground">
          {previewLoading ? "..." : preview ? `(${preview.skills.length})` : ""}
        </span>
      )}
      {ignoredCount > 0 && (
        <span
          className="text-xs text-amber-600"
          title="Profile entries that are disabled or not assigned to this target are ignored"
        >
          {ignoredCount} ignored
        </span>
      )}
    </Combobox>
  );
}
