import type { ReactNode } from "react";

export function TimelineRowContent({ children, time }: { children: ReactNode; time?: string }) {
  return (
    <span className="min-w-0 flex-1 sm:flex sm:items-start sm:gap-2">
      <span className="block whitespace-normal [overflow-wrap:anywhere] sm:min-w-0 sm:flex-1">
        {children}
      </span>
      {time && (
        <span className="mt-0.5 block shrink-0 text-xs text-secondary-foreground sm:ml-auto sm:mt-0">
          {time}
        </span>
      )}
    </span>
  );
}
