"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** One-off Docker choice for a new session: the configured default, or an explicit override. */
export type DockerMode = "default" | "standard" | "docker";

export function dockerEnabledForMode(mode: DockerMode): boolean | undefined {
  return mode === "default" ? undefined : mode === "docker";
}

export function DockerModeSelect({
  value,
  onChange,
  disabled,
}: {
  value: DockerMode;
  onChange: (mode: DockerMode) => void;
  disabled?: boolean;
}) {
  return (
    <Select
      value={value}
      onValueChange={(mode) => onChange(mode as DockerMode)}
      disabled={disabled}
    >
      <SelectTrigger className="h-8 w-44 text-xs" aria-label="Sandbox runtime">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="default">Configured sandbox</SelectItem>
        <SelectItem value="standard">Standard sandbox</SelectItem>
        <SelectItem value="docker">Docker sandbox</SelectItem>
      </SelectContent>
    </Select>
  );
}
