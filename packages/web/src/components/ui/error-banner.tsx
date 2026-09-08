import * as React from "react";
import { cn } from "@/lib/utils";

interface ErrorBannerProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  className?: string;
}

export const ErrorBanner = React.forwardRef<HTMLDivElement, ErrorBannerProps>(
  ({ children, className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "rounded-md border border-destructive-border bg-destructive-muted px-4 py-3 text-sm text-destructive",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
);
ErrorBanner.displayName = "ErrorBanner";
