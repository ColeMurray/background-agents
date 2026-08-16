import type { ReactNode } from "react";
import { Checkbox } from "@/components/ui/checkbox";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

export function ScopeCheckbox({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-foreground">
      <Checkbox checked={checked} onCheckedChange={(value) => onChange(value === true)} />
      <span className="truncate">{children}</span>
    </label>
  );
}
