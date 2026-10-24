import type { ReactNode } from "react";

function FieldSkeleton({
  labelWidth,
  controlClassName = "h-9",
  description = false,
}: {
  labelWidth: string;
  controlClassName?: string;
  description?: boolean;
}) {
  return (
    <div>
      <div className={`h-4 ${labelWidth} bg-muted rounded mb-2.5`} />
      <div className={`${controlClassName} w-full bg-muted rounded`} />
      {description && <div className="h-3 w-2/3 bg-muted rounded mt-2" />}
    </div>
  );
}

/** Mirrors the create/edit automation pages while their data loads. */
export function AutomationFormSkeleton({ header }: { header?: ReactNode }) {
  return (
    <div className="h-full flex flex-col">
      {header}
      <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
        <div
          role="status"
          aria-label="Loading automation form"
          className="max-w-2xl mx-auto animate-pulse motion-reduce:animate-none"
        >
          <div className="h-8 w-56 bg-muted rounded mb-6 sm:h-9" />

          <div className="space-y-6">
            <FieldSkeleton labelWidth="w-12" />
            <FieldSkeleton labelWidth="w-24" description />
            <FieldSkeleton labelWidth="w-14" />
            <FieldSkeleton labelWidth="w-40" description />
            <FieldSkeleton labelWidth="w-14" description />
            <FieldSkeleton labelWidth="w-14" description />
            <FieldSkeleton labelWidth="w-32" description />
            <FieldSkeleton labelWidth="w-24" controlClassName="h-32" />
            <div className="flex justify-end">
              <div className="h-9 w-36 bg-muted rounded" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
