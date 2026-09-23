import { cn } from "@/lib/utils";

export function FieldDescription({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p className={cn("text-xs text-muted-foreground mt-1 leading-normal", className)}>{children}</p>
  );
}
