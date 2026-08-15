"use client";

import { useEffect, useState } from "react";
import type { SessionSkillSelection } from "@open-inspect/shared/types/skills";
import {
  useSkillProfiles,
  resolveSkillPreview,
  type SkillResolutionPreviewInput,
} from "@/hooks/use-managed-skills";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { SparkleIcon } from "@/components/ui/icons";

interface SessionSkillSelectorProps {
  value: SessionSkillSelection;
  onChange: (value: SessionSkillSelection) => void;
  target: Omit<SkillResolutionPreviewInput, "selection"> | null;
  disabled?: boolean;
}

function selectionValue(selection: SessionSkillSelection): string {
  return selection.mode === "profile" ? `profile:${selection.profileId}` : selection.mode;
}

export function SessionSkillSelector({
  value,
  onChange,
  target,
  disabled,
}: SessionSkillSelectorProps) {
  const { profiles, loading } = useSkillProfiles();
  const [count, setCount] = useState<number | null>(null);
  const [ignoredCount, setIgnoredCount] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  const targetKey = JSON.stringify(target);
  const valueKey = selectionValue(value);

  useEffect(() => {
    if (targetKey === "null") {
      setCount(null);
      setIgnoredCount(0);
      setPreviewing(false);
      return;
    }
    const previewTarget = JSON.parse(targetKey) as Omit<SkillResolutionPreviewInput, "selection">;
    const selection: SessionSkillSelection =
      valueKey === "all" || valueKey === "none"
        ? { mode: valueKey }
        : { mode: "profile", profileId: valueKey.slice("profile:".length) };
    const controller = new AbortController();
    setPreviewing(true);
    resolveSkillPreview({ ...previewTarget, selection }, controller.signal)
      .then((preview) => {
        setCount(preview.skills.length);
        setIgnoredCount(preview.ignoredProfileSkillIds.length);
      })
      .catch((error) => {
        if (!(error instanceof Error && error.name === "AbortError")) {
          setCount(null);
          setIgnoredCount(0);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setPreviewing(false);
      });
    return () => controller.abort();
  }, [targetKey, valueKey]); // Serialized keys keep target objects from retriggering the preview.

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
          {previewing ? "..." : count === null ? "" : `(${count})`}
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
