import type { ReactNode } from "react";

/** A titled group in the session details panel; groups are separated by spacing, not rules. */
export function DetailsSection({
  title,
  action,
  children,
}: {
  title: string;
  /** A compact control that acts on the whole section, such as a refresh button. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-foreground">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * Label/value rows. Every row uses the same label width, so rows rendered by
 * different components line up as one list.
 */
export function PropertyList({ children }: { children: ReactNode }) {
  return <dl className="space-y-2 text-xs">{children}</dl>;
}

export function PropertyRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-20 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 text-foreground [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}
