import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { ChevronDownIcon } from "@/components/ui/icons";

type SelectDensity = "default" | "compact";

const selectDensityClasses: Record<SelectDensity, string> = {
  default: "px-3 py-2 text-sm",
  compact: "px-2 py-1 text-sm",
};

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  density?: SelectDensity;
}

export function Select({ className = "", density = "default", children, ...props }: SelectProps) {
  return (
    <div className={`relative ${className}`.trim()}>
      <select
        className={`w-full appearance-none rounded-sm border border-border bg-input pr-8 text-foreground transition hover:border-foreground/20 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 ${selectDensityClasses[density]}`.trim()}
        {...props}
      >
        {children}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

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
      className={`flex cursor-pointer items-start gap-2 rounded-sm border px-3 py-2 text-sm transition ${
        checked ? "border-accent bg-accent-muted/70" : "border-border hover:bg-muted/50"
      } ${className}`.trim()}
    >
      <input type="radio" checked={checked} className="sr-only" {...props} />
      <span
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition ${
          checked ? "border-accent" : "border-border"
        }`}
        aria-hidden="true"
      >
        <span
          className={`h-2 w-2 rounded-full bg-accent transition ${checked ? "opacity-100" : "opacity-0"}`}
        />
      </span>
      <span className="leading-5">
        <span className="font-medium text-foreground">{label}</span>
        {description ? <span className="block text-muted-foreground">{description}</span> : null}
      </span>
    </label>
  );
}
