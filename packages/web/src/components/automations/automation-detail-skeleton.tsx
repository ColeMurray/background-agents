import type { ReactNode } from "react";

const DETAIL_FIELD_WIDTHS = ["w-40", "w-16", "w-20", "w-36", "w-24", "w-32"];

/** Mirrors the automation detail page while the automation loads. */
export function AutomationDetailSkeleton({ header }: { header?: ReactNode }) {
  return (
    <div className="h-full flex flex-col">
      {header}
      <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
        <div
          role="status"
          aria-label="Loading automation"
          className="max-w-3xl mx-auto animate-pulse motion-reduce:animate-none"
        >
          {/* Header: name + targets, actions */}
          <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="h-8 w-56 bg-muted rounded sm:h-9" />
              <div className="h-4 w-40 bg-muted rounded mt-2" />
            </div>
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
              <div className="h-8 w-full bg-muted rounded sm:w-16" />
              <div className="h-8 w-full bg-muted rounded sm:w-28" />
              <div className="h-8 w-full bg-muted rounded sm:w-16" />
            </div>
          </div>

          {/* Configuration */}
          <div className="border border-border-muted rounded-md bg-background p-4 mb-8">
            <div className="h-6 w-32 bg-muted rounded mb-4" />
            <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
              {DETAIL_FIELD_WIDTHS.map((width, index) => (
                <div key={index}>
                  <div className="h-4 w-16 bg-muted rounded" />
                  <div className={`h-4 ${width} bg-muted rounded mt-2`} />
                </div>
              ))}
              <div className="sm:col-span-2">
                <div className="h-4 w-20 bg-muted rounded" />
                <div className="h-4 w-full bg-muted rounded mt-2" />
                <div className="h-4 w-2/3 bg-muted rounded mt-2" />
              </div>
            </div>
          </div>

          {/* Run history */}
          <div className="h-6 w-28 bg-muted rounded mb-4" />
          <div className="border border-border-muted rounded-md bg-card divide-y divide-border-muted">
            {[0, 1, 2].map((row) => (
              <div key={row} className="px-4 py-3 flex items-center justify-between gap-4">
                <div className="h-5 w-48 bg-muted rounded" />
                <div className="h-4 w-20 bg-muted rounded" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
