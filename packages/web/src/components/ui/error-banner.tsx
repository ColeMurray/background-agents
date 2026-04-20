import { cn } from "@/lib/utils";

interface ErrorBannerProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  className?: string;
}

export function ErrorBanner({ children, className, ...props }: ErrorBannerProps) {
  return (
    <div
      className={cn(
        "rounded-md border border-destructive-border bg-destructive-muted px-4 py-3 text-sm text-destructive",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}
