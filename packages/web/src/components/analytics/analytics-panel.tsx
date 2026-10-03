import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A titled region of the analytics page; the title names the region for assistive tech. */
export function AnalyticsPanel({
  title,
  description,
  actions,
  footer,
  children,
  className,
  bodyClassName,
}: {
  title?: string;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={title ? headingId : undefined}
      className={cn(
        "flex min-w-0 flex-col rounded-lg border border-border-muted bg-card",
        className
      )}
    >
      {title || actions ? (
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 px-4 pt-3.5">
          <div className="min-w-0">
            {title ? (
              <h3 id={headingId} className="text-sm font-semibold text-foreground">
                {title}
              </h3>
            ) : null}
            {description ? (
              <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-3">{actions}</div> : null}
        </div>
      ) : null}
      <div className={cn("min-w-0 flex-1 p-4", bodyClassName)}>{children}</div>
      {footer ? (
        <div className="border-t border-border-muted px-4 py-2.5 text-xs text-muted-foreground">
          {footer}
        </div>
      ) : null}
    </section>
  );
}

export function AnalyticsEmptyNote({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>;
}
