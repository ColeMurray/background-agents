import type { InputHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

interface RadioCardProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: ReactNode;
  description?: ReactNode;
}

export function RadioCard({
  label,
  description,
  className = "",
  checked,
  ...props
}: RadioCardProps) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-2 rounded-sm border px-3 py-2 text-sm transition",
        checked ? "border-accent bg-accent-muted/70" : "border-border hover:bg-muted/50",
        className
      )}
    >
      <input type="radio" checked={checked} className="sr-only" {...props} />
      <span
        className={cn(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition",
          checked ? "border-accent" : "border-border"
        )}
        aria-hidden="true"
      >
        <span
          className={cn(
            "h-2 w-2 rounded-full bg-accent transition",
            checked ? "opacity-100" : "opacity-0"
          )}
        />
      </span>
      <span className="leading-5">
        <span className="font-medium text-foreground">{label}</span>
        {description ? <span className="block text-muted-foreground">{description}</span> : null}
      </span>
    </label>
  );
}
