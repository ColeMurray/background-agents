import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonVariant = "primary" | "outline" | "ghost" | "destructive" | "subtle";
type ButtonSize = "default" | "sm" | "xs" | "icon";

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "text-white bg-accent hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed",
  outline: "border border-border text-foreground hover:bg-muted",
  ghost: "text-muted-foreground hover:text-foreground hover:bg-muted",
  destructive:
    "text-red-600 hover:text-red-700 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed",
  subtle:
    "text-secondary-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed",
};

const sizeClasses: Record<ButtonSize, string> = {
  default: "px-4 py-2 text-sm font-medium",
  sm: "px-3 py-1.5 text-sm",
  xs: "px-2 py-1 text-xs",
  icon: "p-1.5",
};

export function buttonVariants({
  variant = "primary",
  size = "default",
  className = "",
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
} = {}) {
  return `${variantClasses[variant]} ${sizeClasses[size]} transition ${className}`.trim();
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
}

export function Button({
  variant = "primary",
  size = "default",
  className = "",
  children,
  ...props
}: ButtonProps) {
  return (
    <button className={buttonVariants({ variant, size, className })} {...props}>
      {children}
    </button>
  );
}
